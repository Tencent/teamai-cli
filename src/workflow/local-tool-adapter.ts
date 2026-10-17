import type { ChildProcess, SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { opencodeMajorVersion } from '../opencode-hooks.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import type { TokenUsage, WorkflowFailure } from './types.js';

const LOCAL_WORKFLOW_TOOLS = ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode'] as const;

export type LocalWorkflowTool = (typeof LOCAL_WORKFLOW_TOOLS)[number];

export function isLocalWorkflowTool(value: string): value is LocalWorkflowTool {
  return (LOCAL_WORKFLOW_TOOLS as readonly string[]).includes(value);
}

export function localToolFamily(tool: LocalWorkflowTool): 'claude' | 'codex' | 'opencode' {
  if (tool === 'codex' || tool === 'codex-internal' || tool === 'tcodex') return 'codex';
  if (tool === 'opencode') return 'opencode';
  return 'claude';
}

export interface LocalToolRun {
  prompt: string;
  cwd: string;
  resultPath: string;
  /** The definition the step runs as. `settings` are the deployed OpenCode file's other fields, such as `mode` and `variant`. */
  agent?: { name: string; instructions: string; model?: string; settings?: Record<string, unknown> };
  /** The model and effort the launch passes: the step's, which replaces the definition's, or on OpenCode the definition's own. */
  model?: { name: string; effort?: string };
}

export interface LocalToolResult {
  exitCode: number;
  output?: unknown;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

export interface LocalToolAdapter {
  run(tool: LocalWorkflowTool, input: LocalToolRun): Promise<LocalToolResult>;
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type ToolResolve = (command: string) => string | null;

interface ResultFile {
  output?: unknown;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

function resultInstruction(input: LocalToolRun, prompt: string): string {
  return `${prompt}\n\nWrite the workflow result as JSON to ${input.resultPath}. `
    + 'Use this shape: {"output":{},"failure":{"code":"optional","message":"optional"}}.';
}

/** Codex, and OpenCode 1 for a subagent, which `opencode run --agent` does not start, get the definition's instructions in the prompt. */
function promptHandoff(tool: LocalWorkflowTool, input: LocalToolRun, opencodeMajor: number): boolean {
  const family = localToolFamily(tool);
  return family === 'codex' || (family === 'opencode' && opencodeMajor < 2 && input.agent?.settings?.['mode'] === 'subagent');
}

function invocation(tool: LocalWorkflowTool, input: LocalToolRun, opencodeMajor: number): string[] {
  const family = localToolFamily(tool);
  const viaPrompt = promptHandoff(tool, input, opencodeMajor);
  const agentPrompt = input.agent?.instructions
    ? `${input.agent.instructions}\n\n${input.prompt}`
    : input.prompt;
  const prompt = resultInstruction(input, viaPrompt ? agentPrompt : input.prompt);
  const agent = input.agent && !viaPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model.name] : [];
  const effort = input.model?.effort;
  if (family === 'claude') {
    return ['-p', prompt, '--output-format', 'json', ...agent, ...model, ...(effort ? ['--effort', effort] : [])];
  }
  if (family === 'codex') {
    const codexModel = input.model?.name ?? input.agent?.model;
    return ['exec', '--json', ...(codexModel ? ['--model', codexModel] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
  }
  // OpenCode 2 has no `--variant` and reads the effort from `--model provider/model#variant`.
  const opencodeModel = input.model && effort && opencodeMajor >= 2 ? ['--model', `${input.model.name}#${effort}`] : [...model, ...(effort ? ['--variant', effort] : [])];
  return ['run', '--format', 'json', prompt, ...agent, ...opencodeModel];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function claudeStdout(stdout: string): ResultFile | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const usage = record.usage as Record<string, unknown> | undefined;
    let output: unknown;
    if (typeof record.result === 'string') {
      try {
        output = JSON.parse(record.result) as unknown;
      } catch {
        output = undefined;
      }
    } else if (record.result !== undefined) {
      output = record.result;
    }
    return {
      ...(output !== undefined ? { output } : {}),
      ...(typeof record.model === 'string' ? { model: record.model } : {}),
      ...(typeof record.session_id === 'string' ? { session: record.session_id } : {}),
      ...(usage ? {
        tokens: {
          ...(finiteNumber(usage.input_tokens) !== undefined ? { input: finiteNumber(usage.input_tokens) } : {}),
          ...(finiteNumber(usage.output_tokens) !== undefined ? { output: finiteNumber(usage.output_tokens) } : {}),
          ...(finiteNumber(usage.cache_read_input_tokens) !== undefined ? { cachedInput: finiteNumber(usage.cache_read_input_tokens) } : {}),
        },
      } : {}),
    };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonRecords(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = asRecord(JSON.parse(trimmed) as unknown);
      if (value) records.push(value);
    } catch {
      // A tool may print a non-JSON line beside its JSON events.
    }
  }
  return records;
}

function tokenUsage(record: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(record.usage) ?? asRecord(record.tokens);
  if (!usage) return undefined;
  const cache = asRecord(usage.cache);
  const tokens: TokenUsage = {};
  const input = finiteNumber(usage.input_tokens) ?? finiteNumber(usage.input);
  const output = finiteNumber(usage.output_tokens) ?? finiteNumber(usage.output);
  const cached = finiteNumber(usage.cached_input_tokens)
    ?? finiteNumber(usage.cache_read_input_tokens)
    ?? finiteNumber(cache?.read);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cached !== undefined) tokens.cachedInput = cached;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function addTokens(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const sum = (left?: number, right?: number) => (
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
  );
  const tokens: TokenUsage = {};
  const input = sum(current?.input, next.input);
  const output = sum(current?.output, next.output);
  const cached = sum(current?.cachedInput, next.cachedInput);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cached !== undefined) tokens.cachedInput = cached;
  return tokens;
}

function absorbMetadata(record: Record<string, unknown>, found: ResultFile, depth: number): void {
  if (typeof record.model === 'string' && record.model !== '') found.model = record.model;
  if (typeof record.modelID === 'string' && record.modelID !== '') found.model = record.modelID;
  for (const key of ['thread_id', 'session_id', 'sessionID'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.session = value;
  }
  if (typeof record.type === 'string' && record.type.startsWith('session')) {
    const info = asRecord(asRecord(record.properties)?.info) ?? asRecord(record.info);
    if (typeof info?.id === 'string' && info.id !== '') found.session = info.id;
  }
  if (record.type === 'turn.completed' || record.type === 'step_finish' || record.type === 'step-finish') {
    const tokens = tokenUsage(record);
    if (tokens) found.tokens = addTokens(found.tokens, tokens);
  }
  if (depth >= 4) return;
  for (const key of ['item', 'part', 'properties', 'info'] as const) {
    const child = asRecord(record[key]);
    if (child) absorbMetadata(child, found, depth + 1);
  }
}

function readToolMetadata(stdout: string): ResultFile | null {
  const found: ResultFile = {};
  for (const record of jsonRecords(stdout)) absorbMetadata(record, found, 0);
  if (!found.model && !found.session && !found.tokens) return null;
  return found;
}

function toolStdout(tool: LocalWorkflowTool, stdout: string): ResultFile | null {
  if (localToolFamily(tool) === 'claude') return claudeStdout(stdout);
  return readToolMetadata(stdout);
}

async function persistFallback(resultPath: string, result: ResultFile): Promise<void> {
  const artifact: Record<string, unknown> = {};
  if ('output' in result) artifact.output = result.output;
  if (result.failure) artifact.failure = result.failure;
  await writeJsonAtomic(resultPath, artifact);
}

function combineResults(fileResult: ResultFile | null, reported: ResultFile | null): ResultFile | null {
  if (!fileResult && !reported) return null;
  const result: ResultFile = {};
  if (fileResult && 'output' in fileResult) result.output = fileResult.output;
  else if (reported && 'output' in reported) result.output = reported.output;
  if (fileResult?.failure) result.failure = fileResult.failure;
  else if (reported?.failure) result.failure = reported.failure;
  if (reported?.model) result.model = reported.model;
  if (reported?.session) result.session = reported.session;
  if (reported?.tokens) result.tokens = reported.tokens;
  return result;
}

export function createLocalToolAdapter(
  spawnTool: ToolSpawn = crossSpawn,
  resolveTool: ToolResolve = resolveCliPath,
): LocalToolAdapter {
  return {
    async run(tool, input) {
      await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
      const executable = resolveTool(tool);
      if (!executable) {
        return {
          exitCode: 1,
          failure: { code: 'tool_unavailable', message: `The ${tool} executable is not available on PATH` },
        };
      }
      const opencode = localToolFamily(tool) === 'opencode';
      const opencodeMajor = opencode && (input.agent || input.model?.effort) ? await opencodeMajorVersion(executable) : 1;
      if (opencode && input.agent) {
        const { name, model, settings = {} } = input.agent;
        const viaPrompt = promptHandoff(tool, input, opencodeMajor);
        // OpenCode 1 applies an agent's variant to a launch on the agent's own model that passes none.
        if (opencodeMajor < 2 && !viaPrompt && settings['variant'] !== undefined && input.model && input.model.name === model && input.model.effort === undefined) {
          return {
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
      const args = invocation(tool, input, opencodeMajor);
      const completed = await new Promise<{ exitCode: number; stdout: string; error?: NodeJS.ErrnoException }>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawnTool(executable, args, {
            cwd: input.cwd,
            env: { ...process.env, TEAMAI_WORKFLOW_RESULT: input.resultPath },
            // OpenCode waits for the end of a piped stdin before it starts.
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (error) {
          resolve({ exitCode: 1, stdout: '', error: error as NodeJS.ErrnoException });
          return;
        }
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.resume();
        child.on('error', (error: NodeJS.ErrnoException) => resolve({ exitCode: 1, stdout, error }));
        child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
      });
      if (completed.error?.code === 'ENOENT') {
        return {
          exitCode: completed.exitCode,
          failure: { code: 'tool_unavailable', message: `The ${tool} executable is not available on PATH` },
        };
      }
      if (completed.error) {
        return {
          exitCode: completed.exitCode,
          failure: { code: 'tool_failed', message: `${tool} could not be started` },
        };
      }
      const fileResult = await readResultFile(input.resultPath);
      const reported = toolStdout(tool, completed.stdout);
      const result = combineResults(fileResult, reported);
      if (!result) {
        return {
          exitCode: completed.exitCode,
          failure: { code: 'tool_failed', message: `${tool} did not write a valid workflow result` },
        };
      }
      redactFailure(result, input);
      if (completed.exitCode !== 0 && !result.failure) {
        result.failure = { code: 'tool_failed', message: `${tool} exited with status ${completed.exitCode}` };
      }
      if (!fileResult) await persistFallback(input.resultPath, result);
      return { exitCode: completed.exitCode, ...result };
    },
  };
}
