import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  agentFileExtensionForTool,
  reverseFromClaude,
  reverseFromCodex,
  reverseFromOpencode,
  type AgentSpec,
  type ToolName,
} from '../resources/agent-format.js';
import { getDataHome, resolveToolBaseDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { leaseNext, reportAttempt } from './engine.js';
import { isRecord } from './expression.js';
import { createLocalToolAdapter, isLocalWorkflowTool, localToolFamily, type LocalToolAdapter, type LocalWorkflowTool } from './local-tool-adapter.js';
import type { DriverIdentity, WorkflowEnvelope, WorkflowFailure } from './types.js';
import { isWorkflowError } from './types.js';

export function localDriver(cwd: string): DriverIdentity {
  let machine = 'unknown';
  try {
    machine = os.hostname();
  } catch {
    machine = 'unknown';
  }
  return { kind: 'local', machine, workspace: path.resolve(cwd) };
}

/** Runs a leased command. The lease `env` is set over the inherited environment, so values reach the shell only as variables. */
function runCommand(command: string, cwd: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function jsonStdout(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export interface LocalDriverOptions {
  tools?: Record<string, string>;
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
}

interface Lease {
  attempt: string;
  revision: number;
  command?: string;
  env?: Record<string, string>;
  prompt?: string;
  agent?: string;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function resultPath(config: LocalConfig, runId: string, attempt: string): string {
  return path.join(getDataHome(config), 'workflows', 'runs', runId, 'attempts', attempt, 'result.json');
}

function supportedTool(value: string): value is LocalWorkflowTool {
  return isLocalWorkflowTool(value);
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});
  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function reverseAgent(tool: LocalWorkflowTool, file: string, content: string) {
  const family = localToolFamily(tool);
  if (family === 'claude') return reverseFromClaude(file, content);
  if (family === 'codex') return reverseFromCodex(file, content);
  return reverseFromOpencode(file, content);
}

async function loadAgent(
  tool: LocalWorkflowTool,
  name: string,
  config: LocalConfig,
  toolPaths: TeamaiConfig['toolPaths'] | undefined,
): Promise<AgentSpec | null> {
  const agents = toolPaths?.[tool]?.agents;
  if (!agents) return null;
  // The same directory `teamai pull` writes: the tool base for this scope, not the step's cwd.
  const file = path.join(resolveToolBaseDir(tool, config), agents, `${name}${agentFileExtensionForTool(tool as ToolName)}`);
  const content = await readFileSafe(file);
  if (content === null) return null;
  const reversed = reverseAgent(tool, file, content);
  return reversed.ok ? reversed.spec : null;
}

interface WorktreeSnapshot {
  ok: boolean;
  files: Map<string, string>;
}

function gitStatus(workspace: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: workspace, env: process.env }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, text: stderr.trim() } : { ok: true, text: stdout });
    });
  });
}

function porcelainPath(line: string): string {
  const body = line.length > 3 ? line.slice(3) : line;
  const renamed = body.split(' -> ').at(-1) ?? body;
  return renamed.trim().replaceAll(/^"|"$/g, '');
}

async function hashPath(workspace: string, relative: string): Promise<string> {
  try {
    const content = await fs.readFile(path.resolve(workspace, relative));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'missing';
  }
}

async function snapshotWorktree(workspace: string): Promise<WorktreeSnapshot> {
  const status = await gitStatus(workspace);
  if (!status.ok) return { ok: false, files: new Map() };
  const files = new Map<string, string>();
  for (const line of status.text.split('\n')) {
    if (!line.trim()) continue;
    const relative = porcelainPath(line.replace(/\r$/, ''));
    if (!relative || files.has(relative)) continue;
    files.set(relative, await hashPath(workspace, relative));
  }
  return { ok: true, files };
}

function changedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  if (!after.ok) return [];
  if (!before.ok) return after.files.size === 0 ? [] : [...after.files.keys()];
  const names = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...names].filter((name) => before.files.get(name) !== after.files.get(name));
}

function failureReport(failure: WorkflowFailure): { outcome: 'failed'; message: string; failure: WorkflowFailure } {
  return { outcome: 'failed', message: failure.message, failure };
}

/**
 * Run leased commands one at a time. Each lease and report goes through the
 * same engine operations an external driver calls.
 */
export async function runLocalDriver(
  config: LocalConfig,
  runId: string,
  cwd: string,
  options: LocalDriverOptions = {},
): Promise<WorkflowEnvelope> {
  const driver = localDriver(cwd);
  const tools = { ...config.workflows?.tools, ...options.tools };
  const adapter = options.adapter ?? createLocalToolAdapter();
  const reported = new Set<string>();
  for (;;) {
    const next = await leaseNext(config, runId, driver);
    if (isWorkflowError(next)) return next;
    if ('done' in next.data) return next;
    if ('wait' in next.data) {
      const reason = typeof (next.data.wait as { reason?: unknown }).reason === 'string'
        ? (next.data.wait as { reason: string }).reason
        : 'the next step is not available';
      return { error: { code: 'busy', message: reason } };
    }
    const rawLease = next.data.lease as Record<string, unknown> | undefined;
    if (!rawLease || typeof rawLease.attempt !== 'string' || typeof rawLease.revision !== 'number') {
      return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };
    }
    const env = stringMap(rawLease.env);
    const lease: Lease = {
      attempt: rawLease.attempt,
      revision: rawLease.revision,
      ...(typeof rawLease.command === 'string' ? { command: rawLease.command } : {}),
      ...(env ? { env } : {}),
      ...(typeof rawLease.prompt === 'string' ? { prompt: rawLease.prompt } : {}),
      ...(typeof rawLease.agent === 'string' ? { agent: rawLease.agent } : {}),
    };
    if ((lease.command === undefined) === (lease.prompt === undefined)) {
      return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };
    }
    if (reported.has(lease.attempt)) {
      return { error: { code: 'driver_stuck', message: `Attempt ${lease.attempt} was leased again before it could be reported` } };
    }
    let body: Parameters<typeof reportAttempt>[2];
    const attemptResultPath = resultPath(config, runId, lease.attempt);
    if (lease.command !== undefined) {
      const result = await runCommand(lease.command, driver.workspace, lease.env ?? {});
      const output = jsonStdout(result.stdout);
      await fs.mkdir(path.dirname(attemptResultPath), { recursive: true });
      await writeJsonAtomic(attemptResultPath, output !== undefined ? { output } : {});
      const snippet = result.stderr.trim().slice(0, 400);
      body = {
        attempt: lease.attempt,
        revision: lease.revision,
        outcome: result.exitCode === 0 ? 'success' : 'failed',
        driver,
        ...(output !== undefined ? { outputs: output } : {}),
        exitCode: result.exitCode,
        ...(result.exitCode !== 0
          ? { message: snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}` }
          : {}),
      };
    } else {
      const selected = lease.agent && tools[lease.agent] ? tools[lease.agent] : tools.default;
      if (!selected) {
        const failure = { code: 'tool_unconfigured', message: 'No local workflow tool is configured for this prompt step' };
        body = { attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) };
      } else if (!supportedTool(selected)) {
        const failure = { code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` };
        body = { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, ...failureReport(failure) };
      } else {
        const agent = lease.agent ? await loadAgent(selected, lease.agent, config, options.toolPaths) : undefined;
        if (lease.agent && !agent) {
          const failure = {
            code: 'agent_unavailable',
            message: `Agent "${lease.agent}" is not available for ${selected}. Run teamai pull and try again.`,
          };
          body = { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, ...failureReport(failure) };
        } else {
          if (agent && localToolFamily(selected) === 'codex') {
            const ignored = ignoredCodexSettings(agent);
            if (ignored.length > 0) {
              log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
            }
          }
          const before = await snapshotWorktree(driver.workspace);
          let result;
          try {
            result = await adapter.run(selected, {
              prompt: lease.prompt!,
              cwd: driver.workspace,
              resultPath: attemptResultPath,
              ...(agent ? { agent: { name: lease.agent!, instructions: agent.instructions, ...(agent.model ? { model: agent.model } : {}) } } : {}),
            });
          } catch {
            result = {
              exitCode: 1,
              failure: { code: 'tool_failed', message: `${selected} could not complete the workflow step` },
            };
          }
          const after = await snapshotWorktree(driver.workspace);
          const paths = changedPaths(before, after);
          const dirtyFailure = paths.length > 0
            ? { code: 'read_only_dirty', message: `Read-only prompt step changed repository paths: ${paths.join(', ')}` }
            : undefined;
          const failure = dirtyFailure ?? result.failure;
          body = {
            attempt: lease.attempt,
            revision: lease.revision,
            driver,
            tool: selected,
            ...(result.model ?? agent?.model ? { model: result.model ?? agent?.model } : {}),
            ...(result.session ? { session: result.session } : {}),
            ...(result.tokens ? { tokens: result.tokens } : {}),
            ...(result.output !== undefined ? { outputs: result.output } : {}),
            exitCode: result.exitCode,
            ...(failure ? failureReport(failure) : { outcome: result.exitCode === 0 ? 'success' : 'failed' }),
          };
        }
      }
    }
    const reportedEnvelope = await reportAttempt(config, runId, {
      ...body,
    });
    if (isWorkflowError(reportedEnvelope)) return reportedEnvelope;
    reported.add(lease.attempt);
  }
}
