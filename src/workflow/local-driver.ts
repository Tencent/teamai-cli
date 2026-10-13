import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { LocalConfig } from '../types.js';
import { leaseNext, reportAttempt } from './engine.js';
import type { DriverIdentity, WorkflowEnvelope } from './types.js';
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

function runCommand(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
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

/**
 * Run leased commands one at a time. Each lease and report goes through the
 * same engine operations an external driver calls.
 */
export async function runLocalDriver(config: LocalConfig, runId: string, cwd: string): Promise<WorkflowEnvelope> {
  const driver = localDriver(cwd);
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
    const lease = next.data.lease as { attempt?: unknown; revision?: unknown; command?: unknown } | undefined;
    if (!lease || typeof lease.attempt !== 'string' || typeof lease.revision !== 'number' || typeof lease.command !== 'string') {
      return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };
    }
    if (reported.has(lease.attempt)) {
      return { error: { code: 'driver_stuck', message: `Attempt ${lease.attempt} was leased again before it could be reported` } };
    }
    const result = await runCommand(lease.command, driver.workspace);
    const outputs = jsonStdout(result.stdout);
    const snippet = result.stderr.trim().slice(0, 400);
    const reportedEnvelope = await reportAttempt(config, runId, {
      attempt: lease.attempt,
      revision: lease.revision,
      outcome: result.exitCode === 0 ? 'success' : 'failed',
      driver,
      ...(outputs !== undefined ? { outputs } : {}),
      exitCode: result.exitCode,
      ...(result.exitCode !== 0
        ? { message: snippet === '' ? `command exited with status ${result.exitCode}` : `command exited with status ${result.exitCode}: ${snippet}` }
        : {}),
    });
    if (isWorkflowError(reportedEnvelope)) return reportedEnvelope;
    reported.add(lease.attempt);
  }
}
