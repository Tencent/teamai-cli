import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import { readRun } from '../workflow/store.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const SESSION = '7c1e0000-0000-4000-8000-000000000004';
const driver = { kind: 'test', machine: 'test', workspace: '/work' };
const person = respondProvenance({ kind: 'terminal', caller: { tty: true, evidence: { kind: 'none' } } });
const SHARE = { verdict: 'share', title: 'Retry the pod readiness probe', file: '/tmp/pod-startup.md', namespace: 'k8s' };
const SKIP = { verdict: 'skip', title: '', file: '', namespace: '' };

const TurnSchema = z.object({
  lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), prompt: z.string().optional(), command: z.string().optional() }).optional(),
  hitl: z.object({ step: z.string(), required: z.boolean() }).optional(),
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
 * Starts teamai's default session-close for SESSION with `inputs` over the defaults below, in a scope whose team keeps no
 * workflows, and drives it as a driver with HITL: `learning` returns `learning`, the person answers every approval yes
 * from their terminal, each `score-driver` item returns an empty label, and every command succeeds. What each lease
 * ran, by step, and how the run ended.
 */
async function closeSession(inputs: Record<string, unknown>, learning: Record<string, unknown>): Promise<{ ran: string[]; prompts: string[]; asked: string[]; outcome: string | undefined; config: LocalConfig; run: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-close-run-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  fs.mkdirSync(config.repo.localPath, { recursive: true });
  const started = await startRun(config, 'session-close', { session: SESSION, source: 'claude-code', publish: false, scorers: [], judge: 'here', ...inputs }, { secrets: {} });
  if ('error' in started) throw new Error(started.error.message);
  const run = String(started.data.run);
  const ran: string[] = [];
  const prompts: string[] = [];
  const asked: string[] = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const next = turnOf(await leaseNext(config, run, driver, { can: { hitl: true } }));
    if (next.done) return { ran, prompts, asked, outcome: next.done.outcome, config, run };
    if (next.hitl) {
      asked.push(`${next.hitl.step}${next.hitl.required ? ' (required)' : ''}`);
      turnOf(await respondToHitl(config, run, {}, { step: next.hitl.step, choice: 'yes', provenance: person }));
      continue;
    }
    if (!next.lease) throw new Error(JSON.stringify(next));
    const { step, attempt, revision, prompt, command } = next.lease;
    ran.push(`${step}: ${command ?? prompt?.split('\n')[0] ?? ''}`);
    if (prompt !== undefined) prompts.push(prompt);
    const outputs = step === 'learning' ? learning : step.startsWith('score-driver') ? { label: '' } : undefined;
    turnOf(await reportAttempt(config, run, { attempt, revision, driver, outcome: 'success', ...(outputs ? { outputs } : {}) }));
  }
  throw new Error('the run did not end in 20 turns');
}

describe('a session-close run', () => {
  it('shares the learning after the person approves it, and runs nothing it was not given', async () => {
    const closed = await closeSession({}, SHARE);

    expect(closed.ran).toEqual([
      expect.stringMatching(/^learning: Run `teamai skill get share` and follow it with the person for the claude-code session 7c1e/),
      'contribute: teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id "$SESSION"',
    ]);
    expect(closed.asked).toEqual(['contribute']);
    expect(closed.outcome).toBe('succeeded');
    expect(await readRun(closed.config, closed.run)).toMatchObject({ inputs: { session: SESSION, source: 'claude-code' } });
  });

  it('asks nothing more about the learning when the person has nothing to share', async () => {
    const closed = await closeSession({}, SKIP);

    expect(closed.ran).toEqual([expect.stringMatching(/^learning: /)]);
    expect(closed.asked).toEqual([]);
    expect(closed.outcome).toBe('succeeded');
  });

  it('publishes only after the person approves it, a required approval', async () => {
    const closed = await closeSession({ publish: true }, SKIP);

    expect(closed.asked).toEqual(['publish (required)']);
    expect(closed.ran).toContain(`publish: teamai session push --scrub --session "$SESSION" --source "$SOURCE"`);
    expect(closed.outcome).toBe('succeeded');
  });

  it('judges each scorer here with teamai\'s own judge, and skips the session agent\'s judging', async () => {
    const closed = await closeSession({ scorers: ['review-quality', 'secure-review'], judge: 'here' }, SKIP);

    expect(closed.ran.filter((ran) => ran.startsWith('score'))).toEqual([
      expect.stringMatching(/^score\[0\]: teamai score --session "\$SESSION" --source "\$SOURCE" --scorer "\$SCORER"$/),
      expect.stringMatching(/^score\[1\]: teamai score --session "\$SESSION" --source "\$SOURCE" --scorer "\$SCORER"$/),
    ]);
    expect(closed.outcome).toBe('succeeded');
  });

  it('has the session\'s agent judge each scorer when no judge tool is here, and succeeds when it returns no label', async () => {
    const closed = await closeSession({ scorers: ['review-quality'], judge: 'driver' }, SKIP);

    expect(closed.ran.filter((ran) => ran.startsWith('score'))).toEqual([
      expect.stringMatching(/^score-driver\[0\]: Judge the claude-code session 7c1e.* with the scorer review-quality\. Take the judge work with$/),
    ]);
    expect(closed.prompts.at(-1)).toContain('If teamai answers isolation_unmet, judge_model_unavailable or busy, return an empty label.');
    expect(closed.outcome).toBe('succeeded');
  });

  it('runs no judge when started with no scorers', async () => {
    for (const judge of ['here', 'driver']) {
      const closed = await closeSession({ scorers: [], judge }, SKIP);

      expect(closed.ran.filter((ran) => ran.startsWith('score'))).toEqual([]);
      expect(closed.outcome).toBe('succeeded');
    }
  });
});
