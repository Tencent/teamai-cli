import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const START = '3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a';
const SOLUTION = '9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e';
const INPUTS = { session: '7c1e0000-0000-4000-8000-000000000004', source: 'claude-code', suite: 'benchmarks/frontend', start: START, solution: SOLUTION };
const DRAFT = { verdict: 'draft', file: '/tmp/pod-startup.yaml', path: 'benchmarks/frontend/tasks/pod-startup.yaml' };
const SKIP = { verdict: 'skip', file: '', path: '' };

const driver = { kind: 'test', machine: 'test', workspace: '/work' };
const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });

const TurnSchema = z.object({
  lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), prompt: z.string().optional(), command: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).optional(),
  hitl: z.object({ step: z.string(), required: z.boolean(), message: z.string() }).optional(),
  done: z.object({ outcome: z.string() }).optional(),
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function turnOf(envelope: WorkflowEnvelope): z.infer<typeof TurnSchema> {
  if ('error' in envelope) throw new Error(envelope.error.message);
  return TurnSchema.parse(envelope.data);
}

/**
 * Starts teamai's default teamai-session-to-task with INPUTS in a scope whose team keeps no workflows, and drives it as a
 * driver with HITL: `draft` returns `draft`, the person answers every approval `answer` from their terminal, and every
 * command succeeds. What each lease ran, by step, what was asked, and how the run ended.
 */
async function sessionToTask(draft: Record<string, unknown>, answer: 'yes' | 'no' = 'yes'): Promise<{ ran: string[]; prompts: string[]; asked: string[]; envs: Record<string, string>[]; outcome: string | undefined }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-to-task-run-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  fs.mkdirSync(config.repo.localPath, { recursive: true });
  const started = await startRun(config, 'teamai-session-to-task', INPUTS, { secrets: {} });
  if ('error' in started) throw new Error(started.error.message);
  const run = String(started.data.run);
  const ran: string[] = [];
  const prompts: string[] = [];
  const asked: string[] = [];
  const envs: Record<string, string>[] = [];
  for (let turn = 0; turn < 10; turn += 1) {
    const next = turnOf(await leaseNext(config, run, driver, { can: { hitl: true } }));
    if (next.done) return { ran, prompts, asked, envs, outcome: next.done.outcome };
    if (next.hitl) {
      asked.push(`${next.hitl.step}${next.hitl.required ? ' (required)' : ''}: ${next.hitl.message}`);
      turnOf(await respondToHitl(config, run, {}, { step: next.hitl.step, choice: answer, provenance: person }));
      continue;
    }
    if (!next.lease) throw new Error(JSON.stringify(next));
    const { step, attempt, revision, prompt, command, env } = next.lease;
    ran.push(`${step}: ${command ?? prompt?.split('\n')[0] ?? ''}`);
    if (prompt !== undefined) prompts.push(prompt);
    if (env) envs.push(env);
    turnOf(await reportAttempt(config, run, { attempt, revision, driver, outcome: 'success', ...(step === 'draft' ? { outputs: draft } : {}) }));
  }
  throw new Error('the run did not end in 10 turns');
}

describe('a teamai-session-to-task run', () => {
  it('proposes the drafted task file to the team at its suite path after one optional approval', async () => {
    const run = await sessionToTask(DRAFT);

    expect(run.ran).toEqual([
      'draft: Turn the work this claude-code session 7c1e0000-0000-4000-8000-000000000004 finished (a bug fix, a feature, a refactor) into one task of the benchmark suite in benchmarks/frontend.',
      'propose: teamai push --file "$FILE" --path "$TASK_PATH"',
    ]);
    expect(run.prompts[0]).toContain(`The task starts at commit ${START}; the solution, the commit that completes it, is ${SOLUTION}`);
    expect(run.asked).toEqual(['propose: Propose benchmarks/frontend/tasks/pod-startup.yaml to the team as a pull request?']);
    expect(run.envs).toEqual([{ FILE: '/tmp/pod-startup.yaml', TASK_PATH: 'benchmarks/frontend/tasks/pod-startup.yaml' }]);
    expect(run.outcome).toBe('succeeded');
  });

  it('asks nothing and opens no pull request when the person decides the session is not a good task', async () => {
    const run = await sessionToTask(SKIP);

    expect(run.ran).toEqual([expect.stringMatching(/^draft: /)]);
    expect(run.asked).toEqual([]);
    expect(run.outcome).toBe('succeeded');
  });

  it('opens no pull request when the approval is answered no', async () => {
    const run = await sessionToTask(DRAFT, 'no');

    expect(run.ran).toEqual([expect.stringMatching(/^draft: /)]);
    expect(run.asked).toHaveLength(1);
    expect(run.outcome).toBe('succeeded');
  });
});
