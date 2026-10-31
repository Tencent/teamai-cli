import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { launchEnv, type Launch } from '../../../launch-context.js';
import { opencodeMajorVersion } from '../../../opencode-hooks.js';
import { resolveCliPath } from '../../../utils/cli-path.js';
import { writeJsonAtomic } from '../../../utils/fs.js';
import { log } from '../../../utils/logger.js';
import { stopProcess } from '../../../tool-launch/process-stop.js';
import { tokenMeter, toolStdout, type TokenUsage, type ToolReport } from '../../../tool-launch/stdout.js';
import type { LaunchAdapter } from '../../../tool-launch/adapters.js';
import { executableOf, launchAdapterIdOf, launchAdapterOf, opencodeModelArgs, type LaunchTool } from '../../../tool-launch/tools.js';
import { budgeted } from '../../limits.js';
import type { Limit } from '../../requirements.js';
import { MAX_TIMER_DELAY } from '../../shell-command.js';
import type { StepModel } from '../../step-model.js';
import type { WorkflowFailure } from '../../types.js';
import { agyGatewayEnv } from '../../../models/agy-gateway.js';

export interface LocalToolRun {
  prompt: string;
  cwd: string;
  resultPath: string;
  /** The definition the step runs as. `settings` are the deployed OpenCode file's other fields, such as `mode` and `variant`. */
  agent?: { name: string; instructions: string; model?: string; settings?: Record<string, unknown> };
  /** The model and effort the launch passes: the step's, which replaces the definition's, or on Codex and OpenCode the definition's own. */
  model?: StepModel;
  /** The workflow launch the tool's session-start hook reads from its environment (#1176). */
  launch?: Launch;
  /** A session id from the same tool. Claude and Codex resume it; OpenCode has no resume flag here. */
  resume?: string;
  /** The environment the tool runs with, scoped to the env keys its lease provides; the inherited one when unset. */
  env?: NodeJS.ProcessEnv;
  /** The most agent turns headless Claude may take. Other tools have no such flag. */
  maxTurns?: number;
  /** The most tokens the run may bill, counted as a budget counts them: once its stdout states more, it is stopped. */
  budget?: number;
  /** How long the tool may run from its spawn before it is stopped. */
  timeoutMs?: number;
  /** Launch the tool in its own mode for editing and running commands without asking (`permissions: unattended`). */
  unattended?: true;
}

/**
 * What a run gave. `started` is whether the tool's process spawned, as its `spawn` event says, so a pass that
 * launched nothing records no observation of a launch (#1176).
 */
export type LocalToolResult =
  | {
    started: true;
    exitCode: number;
    /** How the launch handed over the definition, when it ran one. */
    applied?: 'main' | 'prompt';
    output?: unknown;
    model?: string;
    session?: string;
    tokens?: TokenUsage;
    /** What the tool said the run cost, as it said it. */
    cost?: ToolReport['cost'];
    /**
     * The limit that ended the run: the first one at which the adapter stopped the tool, its timeout or its budget, or
     * the turn cap, at which headless Claude ends itself with `error_max_turns`.
     */
    stoppedBy?: Limit;
    failure?: WorkflowFailure;
  }
  | { started: false; exitCode: number; failure: WorkflowFailure };

export interface LocalToolAdapter {
  run(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
  /** Opens a foreground tool for a person, with an optional structured result. */
  runInteractive(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type ToolResolve = (command: string) => string | null;

type ResultFile = ToolReport & { failure?: WorkflowFailure };

function resultInstruction(input: LocalToolRun, prompt: string): string {
  return `${prompt}\n\nWrite the workflow result as JSON to ${input.resultPath}. `
    + 'Use this shape: {"output":{},"failure":{"code":"optional","message":"optional"}}.';
}

/** Codex, and OpenCode 1 for a subagent, which `opencode run --agent` does not start, get the definition's instructions in the prompt. */
function promptHandoff(tool: LaunchTool, input: LocalToolRun, opencodeMajor: number): boolean {
  const family = launchAdapterIdOf(tool);
  return family === 'codex' || (family === 'opencode' && opencodeMajor < 2 && input.agent?.settings?.['mode'] === 'subagent');
}

/** The arguments that launch `tool` unattended, or `'none'` when teamai knows no such mode of it. */
function unattendedArgs(tool: LaunchTool): readonly string[] | 'none' {
  const adapter: LaunchAdapter = launchAdapterOf(tool);
  const unattended = adapter.step?.unattended ?? 'none';
  return unattended === 'none' ? 'none' : unattended.args;
}

function invocation(tool: LaunchTool, input: LocalToolRun, opencodeMajor: number, interactive: boolean): string[] {
  const family = launchAdapterIdOf(tool);
  const modeArgs = input.unattended ? unattendedArgs(tool) : [];
  const unattended = modeArgs === 'none' ? [] : modeArgs;
  const viaPrompt = promptHandoff(tool, input, opencodeMajor);
  const agentPrompt = input.agent?.instructions
    ? `${input.agent.instructions}\n\n${input.prompt}`
    : input.prompt;
  const prompt = resultInstruction(input, viaPrompt ? agentPrompt : input.prompt);
  const agent = input.agent && !viaPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model.name] : [];
  const effort = input.model?.effort;
  const resume = input.resume ? ['--resume', input.resume] : [];
  const turns = input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : [];
  switch (family) {
    case 'claude':
      if (interactive) return [...unattended, ...agent, ...model, ...(effort ? ['--effort', effort] : []), ...resume, prompt];
      // Only partial messages state each message's final usage as it ends, which the budget meter counts.
      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(input.budget !== undefined ? ['--include-partial-messages'] : []), ...unattended, ...turns, ...agent, ...model, ...(effort ? ['--effort', effort] : []), ...resume];
    case 'codebuddy':
      // Claude's flags, with no --effort.
      if (interactive) return [...unattended, ...agent, ...model, ...resume, prompt];
      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...unattended, ...turns, ...agent, ...model, ...resume];
    case 'codex': {
      if (interactive) return [...(input.resume ? ['resume', input.resume] : []), ...unattended, ...model, ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
      const codexModel = input.model?.name ?? input.agent?.model;
      const codexResume = input.resume ? ['resume', input.resume] : [];
      return ['exec', ...codexResume, '--json', ...unattended, ...(codexModel ? ['--model', codexModel] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
    }
    case 'opencode':
      if (interactive) return [...unattended, ...agent, ...model, '--prompt', prompt];
      return ['run', '--format', 'json', ...unattended, prompt, ...agent, ...opencodeModelArgs(input.model, opencodeMajor)];
    case 'agy': {
      const conversation = input.resume ? ['--conversation', input.resume] : [];
      const agyEffort = effort ? ['--effort', effort] : [];
      if (interactive) return [...unattended, ...agent, ...model, ...agyEffort, ...conversation, '--prompt-interactive', prompt];
      // `--print=` keeps the prompt attached: a bare `-p` takes its next argument as the prompt, even a flag.
      return ['--output-format=stream-json', ...unattended, ...agent, ...model, ...agyEffort, ...conversation, `--print=${prompt}`];
    }
    default: {
      const unhandled: never = family;
      throw new Error(`No workflow step profile for adapter ${String(unhandled)}`);
    }
  }
}

function parseResultFile(value: unknown): ResultFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: ResultFile = {};
  if ('output' in record) result.output = record.output;
  if (record.failure !== undefined) {
    if (!record.failure || typeof record.failure !== 'object' || Array.isArray(record.failure)) return null;
    const failure = record.failure as Record<string, unknown>;
    if (typeof failure.code !== 'string' || typeof failure.message !== 'string') return null;
    result.failure = { code: failure.code, message: failure.message };
  }
  return result;
}

async function readResultFile(resultPath: string): Promise<ResultFile | null> {
  try {
    return parseResultFile(JSON.parse(await fs.readFile(resultPath, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function redactFailure(result: ResultFile, input: LocalToolRun): void {
  if (!result.failure) return;
  for (const secret of [input.prompt, input.agent?.instructions]) {
    if (secret) result.failure.message = result.failure.message.replaceAll(secret, '[prompt omitted]');
  }
}

async function persistFallback(resultPath: string, result: ResultFile): Promise<void> {
  const artifact: Record<string, unknown> = {};
  if ('output' in result) artifact.output = result.output;
  if (result.failure) artifact.failure = result.failure;
  await writeJsonAtomic(resultPath, artifact);
}

function combineResults(fileResult: ResultFile | null, reported: ToolReport | null): ResultFile | null {
  if (!fileResult && !reported) return null;
  const result: ResultFile = {};
  if (fileResult && 'output' in fileResult) result.output = fileResult.output;
  else if (reported && 'output' in reported) result.output = reported.output;
  if (fileResult?.failure) result.failure = fileResult.failure;
  if (reported?.model) result.model = reported.model;
  if (reported?.session) result.session = reported.session;
  if (reported?.tokens) result.tokens = reported.tokens;
  if (reported?.cost) result.cost = reported.cost;
  return result;
}

export function createLocalToolAdapter(
  spawnTool: ToolSpawn = crossSpawn,
  resolveTool: ToolResolve = resolveCliPath,
): LocalToolAdapter {
  const launch =
    async (tool: LaunchTool, input: LocalToolRun, signal: AbortSignal | undefined, interactive: boolean): Promise<LocalToolResult> => {
      await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
      const executable = resolveTool(executableOf(tool));
      if (!executable) {
        return {
          started: false,
          exitCode: 1,
          failure: { code: 'tool_unavailable', message: `The ${tool} executable is not available on PATH` },
        };
      }
      if (input.unattended && unattendedArgs(tool) === 'none') {
        return {
          started: false,
          exitCode: 1,
          failure: { code: 'tool_unavailable', message: `The step sets permissions: unattended, and ${tool} has no unattended mode teamai knows. Run the step on a tool that has one, or remove permissions from the step.` },
        };
      }
      const opencode = launchAdapterIdOf(tool) === 'opencode';
      const opencodeMajor = opencode && (input.agent || input.model?.effort) ? await opencodeMajorVersion(executable) : 1;
      if (opencode && input.agent) {
        const { name, model, settings = {} } = input.agent;
        const viaPrompt = promptHandoff(tool, input, opencodeMajor);
        // OpenCode 1 applies an agent's variant to a launch on the agent's own model that passes none.
        if (opencodeMajor < 2 && !viaPrompt && settings['variant'] !== undefined && input.model && input.model.name === model && input.model.effort === undefined) {
          return {
            started: false,
            exitCode: 1,
            failure: {
              code: 'model_unavailable',
              message: `Agent "${name}" runs on its own model "${model}" with no effort, and ${tool} 1 applies the agent's variant "${String(settings['variant'])}" `
                + `to that model. Remove model from the step to run at that variant, or set it to an alias with an effort for ${tool}.`,
            },
          };
        }
        // The variant goes on argv with a model, the definition's or the step's.
        const dropped = Object.keys(settings).filter((key) => key !== 'mode' && (key !== 'variant' || !input.model));
        if (viaPrompt && dropped.length > 0) {
          log.warn(`Agent "${name}" runs on ${tool} 1 from the prompt, since opencode run does not start a subagent there, so it does not apply `
            + `${dropped.join(', ')} from the deployed agent file. The step is not blocked.`);
        } else if (opencodeMajor >= 2 && settings['variant'] !== undefined && !input.model) {
          log.warn(`Agent "${name}" sets a variant with no model, and ${tool} 2 takes a variant only with a model, so it does not apply variant `
            + 'from the deployed agent file. The step is not blocked.');
        }
      }
      const args = invocation(tool, input, opencodeMajor, interactive);
      const applied = input.agent ? { applied: promptHandoff(tool, input, opencodeMajor) ? 'prompt' as const : 'main' as const } : {};
      let started = false;
      let childProcess: ChildProcess | undefined;
      const meter = input.budget !== undefined ? tokenMeter(launchAdapterIdOf(tool)) : undefined;
      let metered: TokenUsage | undefined;
      // The first reason a stop was sent, so a limit crossed while the tool shuts down does not replace it.
      let stopCause: 'timeout' | 'budget' | 'aborted' | undefined;
      const stopAt = (limit: 'timeout' | 'budget'): void => {
        stopCause ??= limit;
        void stop?.();
      };
      const closed = new Promise<{ exitCode: number; stdout: string; error?: NodeJS.ErrnoException }>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawnTool(executable, args, {
            cwd: input.cwd,
            env: {
              ...input.env ?? process.env,
              // A model switch hands agy its gateway through a shell function, and this launch runs no shell.
              ...(launchAdapterIdOf(tool) === 'agy' ? agyGatewayEnv(input.env ?? process.env) : {}),
              ...(input.launch ? launchEnv(input.launch) : {}),
              TEAMAI_WORKFLOW_RESULT: input.resultPath,
            },
            // OpenCode waits for the end of a piped stdin before it starts.
            stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
            detached: !interactive && process.platform !== 'win32',
            windowsHide: true,
          });
        } catch (error) {
          resolve({ exitCode: 1, stdout: '', error: error as NodeJS.ErrnoException });
          return;
        }
        childProcess = child;
        const timer = input.timeoutMs !== undefined && input.timeoutMs <= MAX_TIMER_DELAY
          ? setTimeout(() => stopAt('timeout'), input.timeoutMs)
          : undefined;
        let stdout = '';
        let partial = '';
        const decoder = new StringDecoder('utf8');
        child.on('spawn', () => { started = true; });
        child.stdout?.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk);
          stdout += text;
          if (!meter || input.budget === undefined) return;
          // A long line arrives over many chunks: only the chunk that ends it is split.
          const end = text.lastIndexOf('\n');
          if (end === -1) {
            partial += text;
            return;
          }
          const lines = `${partial}${text.slice(0, end)}`.split('\n');
          partial = text.slice(end + 1);
          for (const line of lines) metered = meter(line);
          if (budgeted(metered) > input.budget) stopAt('budget');
        });
        child.stderr?.resume();
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve({ exitCode: 1, stdout, error });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout: stdout + decoder.end() });
        });
      });
      const stop = childProcess && stopProcess(childProcess, closed, !interactive && process.platform !== 'win32');
      const abort = (): void => {
        const reason: unknown = signal?.reason;
        const forwarded = reason === 'SIGINT' || reason === 'SIGQUIT' || reason === 'SIGTERM' || reason === 'SIGHUP' ? reason : undefined;
        stopCause ??= 'aborted';
        void stop?.(interactive ? forwarded : undefined);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const completed = await closed;
      if (stopCause !== undefined) await stop?.();
      signal?.removeEventListener('abort', abort);
      const stopped = stopCause === 'aborted' ? undefined : stopCause;
      if (!started || completed.error?.code === 'ENOENT') {
        return {
          started: false,
          exitCode: completed.exitCode,
          failure: completed.error?.code === 'ENOENT'
            ? { code: 'tool_unavailable', message: `The ${tool} executable is not available on PATH` }
            : { code: 'tool_failed', message: `${tool} could not be started` },
        };
      }
      if (completed.error) {
        return {
          started: true,
          exitCode: completed.exitCode,
          ...applied,
          ...(stopped ? { stoppedBy: stopped } : {}),
          failure: { code: 'tool_failed', message: `${tool} could not be started` },
        };
      }
      const fileResult = await readResultFile(input.resultPath);
      const printed = toolStdout(launchAdapterIdOf(tool), completed.stdout);
      // Only a tool stopped at a limit may end before its result: one that ended there on its own wrote none.
      const stated = printed?.unfinished && !stopped ? null : printed;
      // A tool stopped mid-run, such as Claude before its final result, states no total: what the meter counted stands in.
      const reported = metered && !stated?.tokens ? { ...stated, tokens: metered } : stated;
      const result = combineResults(fileResult, reported) ?? (interactive ? {} : null);
      const stoppedBy: Limit | undefined = stopped ?? (stated?.reachedMaxTurns ? 'max_turns' : undefined);
      const ended = stoppedBy ? { stoppedBy } : {};
      if (!result) {
        return {
          started: true,
          exitCode: completed.exitCode,
          ...applied,
          ...ended,
          failure: { code: 'tool_failed', message: `${tool} did not write a valid workflow result` },
        };
      }
      redactFailure(result, input);
      if (completed.exitCode !== 0 && !result.failure) {
        result.failure = { code: 'tool_failed', message: `${tool} exited with status ${completed.exitCode}` };
      }
      if (!fileResult) await persistFallback(input.resultPath, result);
      return { started: true, exitCode: completed.exitCode, ...applied, ...ended, ...result };
    };
  return {
    run(tool, input, signal) {
      return launch(tool, input, signal, false);
    },
    runInteractive(tool, input, signal) {
      return launch(tool, input, signal, true);
    },
  };
}
