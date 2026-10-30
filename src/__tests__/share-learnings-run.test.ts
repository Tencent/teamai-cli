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
const SHARE = { learnings: [
  { title: 'Retry the pod readiness probe', file: '/tmp/pod-startup.md', namespace: 'k8s' },
  { title: 'pnpm needs --frozen-lockfile in CI', file: '/tmp/pnpm-ci.md', namespace: '' },
] };
const SKIP = { learnings: [] };

const TurnSchema = z.object({
  lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), prompt: z.string().optional(), command: z.string().optional(), env: z.record(z.string()).optional() }).optional(),
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
 * Starts teamai's default teamai-share-learnings for SESSION with `inputs` over the defaults below, in a scope whose team keeps no
 * workflows, and drives it as a driver with HITL: `learning` returns `learning`, the person answers every approval yes
 * from their terminal, each `score-driver` item returns an empty label, and every command succeeds. What each lease
 * ran, by step, and how the run ended.
 */
async function shareLearnings(inputs: Record<string, unknown>, learning: Record<string, unknown>): Promise<{ ran: string[]; prompts: string[]; asked: string[]; contributed: Record<string, string>[]; outcome: string | undefined; config: LocalConfig; run: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-share-learnings-run-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  fs.mkdirSync(config.repo.localPath, { recursive: true });
  const started = await startRun(config, 'teamai-share-learnings', { session: SESSION, source: 'claude-code', publish: false, scorers: [], judge: 'here', ...inputs }, { secrets: {} });
  if ('error' in started) throw new Error(started.error.message);
  const run = String(started.data.run);
  const ran: string[] = [];
  const prompts: string[] = [];
  const asked: string[] = [];
  const contributed: Record<string, string>[] = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const next = turnOf(await leaseNext(config, run, driver, { can: { hitl: true } }));
    if (next.done) return { ran, prompts, asked, contributed, outcome: next.done.outcome, config, run };
    if (next.hitl) {
      asked.push(`${next.hitl.step}${next.hitl.required ? ' (required)' : ''}`);
      turnOf(await respondToHitl(config, run, {}, { step: next.hitl.step, choice: 'yes', provenance: person }));
      continue;
    }
    if (!next.lease) throw new Error(JSON.stringify(next));
    const { step, attempt, revision, prompt, command, env } = next.lease;
    if (step.startsWith('contribute') && env) contributed.push(env);
    ran.push(`${step}: ${command ?? prompt?.split('\n')[0] ?? ''}`);
    if (prompt !== undefined) prompts.push(prompt);
    const outputs = step === 'learning' ? learning : step.includes('score-driver') ? { label: '' } : undefined;
    turnOf(await reportAttempt(config, run, { attempt, revision, driver, outcome: 'success', ...(outputs ? { outputs } : {}) }));
  }
  throw new Error('the run did not end in 20 turns');
}

describe('a teamai-share-learnings run', () => {
  it('shares every learning the person wrote after one approval, each linked to the session', async () => {
    const shared = await shareLearnings({}, SHARE);

    expect(shared.ran).toEqual([
      expect.stringMatching(/^learning: Run `teamai skill get share` and follow it with the person for the claude-code session 7c1e/),
      'contribute[0]: teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id "$SESSION"',
      'contribute[1]: teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id "$SESSION"',
    ]);
    expect(shared.asked).toEqual(['approve']);
    expect(shared.contributed).toEqual([
      { FILE: '/tmp/pod-startup.md', TITLE: 'Retry the pod readiness probe', NS: 'k8s', SESSION },
      { FILE: '/tmp/pnpm-ci.md', TITLE: 'pnpm needs --frozen-lockfile in CI', NS: '', SESSION },
    ]);
    expect(shared.outcome).toBe('succeeded');
    expect(await readRun(shared.config, shared.run)).toMatchObject({ inputs: { session: SESSION, source: 'claude-code' } });
  });

  it('asks nothing more about the learning when the person has nothing to share', async () => {
    const shared = await shareLearnings({}, SKIP);

    expect(shared.ran).toEqual([expect.stringMatching(/^learning: /)]);
    expect(shared.asked).toEqual([]);
    expect(shared.outcome).toBe('succeeded');
  });

  it('publishes only after the person approves it, a required approval', async () => {
    const shared = await shareLearnings({ publish: true }, SKIP);

    expect(shared.asked).toEqual(['share-session.publish (required)']);
    expect(shared.ran).toContain(`share-session.publish: teamai session push --scrub --session "$SESSION" --source "$SOURCE"`);
    expect(shared.outcome).toBe('succeeded');
  });

  it('judges each scorer here with teamai\'s own judge, and skips the session agent\'s judging', async () => {
    const shared = await shareLearnings({ scorers: ['review-quality', 'secure-review'], judge: 'here' }, SKIP);

    expect(shared.ran.filter((ran) => ran.startsWith('share-session.score'))).toEqual([
      expect.stringMatching(/^share-session\.score\[0\]: teamai score --session "\$SESSION" --source "\$SOURCE" --scorer "\$SCORER"$/),
      expect.stringMatching(/^share-session\.score\[1\]: teamai score --session "\$SESSION" --source "\$SOURCE" --scorer "\$SCORER"$/),
    ]);
    expect(shared.outcome).toBe('succeeded');
  });

  it('has the session\'s agent judge each scorer when no judge tool is here, and succeeds when it returns no label', async () => {
    const shared = await shareLearnings({ scorers: ['review-quality'], judge: 'driver' }, SKIP);

    expect(shared.ran.filter((ran) => ran.startsWith('share-session.score'))).toEqual([
      expect.stringMatching(/^share-session\.score-driver\[0\]: Judge the claude-code session 7c1e.* with the scorer review-quality\. Take the judge work with$/),
    ]);
    expect(shared.prompts.at(-1)).toContain('If teamai answers isolation_unmet, judge_model_unavailable or busy, return an empty label.');
    expect(shared.outcome).toBe('succeeded');
  });

  it('runs no judge when started with no scorers', async () => {
    for (const judge of ['here', 'driver']) {
      const shared = await shareLearnings({ scorers: [], judge }, SKIP);

      expect(shared.ran.filter((ran) => ran.startsWith('share-session.score'))).toEqual([]);
      expect(shared.outcome).toBe('succeeded');
    }
  });
});
