import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TokenUsage, WorkflowFailure } from './types.js';

export type LocalWorkflowTool = 'claude' | 'codex' | 'opencode';

export interface LocalToolRun {
  prompt: string;
  cwd: string;
  resultPath: string;
  agent?: { name: string; instructions: string; model?: string };
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

interface ResultFile {
  output?: unknown;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

function resultInstruction(input: LocalToolRun, prompt: string): string {
  return `${prompt}\n\nWrite the final workflow result as JSON to ${input.resultPath}. `
    + 'Use this shape: {"output":{},"model":"optional","session":"optional","tokens":{"input":1,"output":2,"cachedInput":0},"failure":{"code":"optional","message":"optional"}}.';
}

function invocation(tool: LocalWorkflowTool, input: LocalToolRun): { command: string; args: string[] } {
  const agentPrompt = input.agent?.instructions
    ? `${input.agent.instructions}\n\n${input.prompt}`
    : input.prompt;
  const prompt = resultInstruction(input, tool === 'codex' ? agentPrompt : input.prompt);
  if (tool === 'claude') {
    return {
      command: 'claude',
      args: ['-p', prompt, '--output-format', 'json', ...(input.agent ? ['--agent', input.agent.name] : [])],
    };
  }
  if (tool === 'codex') {
    return {
      command: 'codex',
      args: ['exec', ...(input.agent?.model ? ['--model', input.agent.model] : []), prompt],
    };
  }
  return {
    command: 'opencode',
    args: ['run', prompt, ...(input.agent ? ['--agent', input.agent.name] : [])],
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTokens(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokens: TokenUsage = {};
  const input = finiteNumber(record.input);
  const output = finiteNumber(record.output);
  const cachedInput = finiteNumber(record.cachedInput);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cachedInput !== undefined) tokens.cachedInput = cachedInput;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function parseResultFile(value: unknown): ResultFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: ResultFile = {};
  if ('output' in record) result.output = record.output;
  if (typeof record.model === 'string') result.model = record.model;
  if (typeof record.session === 'string') result.session = record.session;
  result.tokens = parseTokens(record.tokens);
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

export function createLocalToolAdapter(spawnTool: ToolSpawn = spawn): LocalToolAdapter {
  return {
    async run(tool, input) {
      await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
      const call = invocation(tool, input);
      const completed = await new Promise<{ exitCode: number; stdout: string; error?: NodeJS.ErrnoException }>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawnTool(call.command, call.args, {
            cwd: input.cwd,
            env: { ...process.env, TEAMAI_WORKFLOW_RESULT: input.resultPath },
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
      const result = fileResult ?? (tool === 'claude' ? claudeStdout(completed.stdout) : null);
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
      return { exitCode: completed.exitCode, ...result };
    },
  };
}
