import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DigestFailure } from '../digest-failures.js';
import { SelfImprovement } from '../self-improvement.js';
import { canonicalJson } from '../utils/canonical-json.js';

const HERE = 'a'.repeat(40);
const ELSEWHERE = 'b'.repeat(40);

/** A failing label of `scorer` for session `sessionId`, judged by `judge`, whose work started as `start` says. */
function failing(sessionId: string, start: DigestFailure['start'], { scorer = 'review-quality', judge = 'model' }: { scorer?: string; judge?: 'model' | 'human' } = {}): DigestFailure {
  return {
    failure: {
      scorer, rubric: { sourceHash: 'rubric-1' }, label: 'missed-bug', score: 0, scoredAt: '2026-10-30T10:00:00.000Z', cohort: 'c1', author: 'alice',
      judge: judge === 'human' ? { kind: 'human' } : { kind: 'model', tool: 'claude', model: { id: 'claude-opus-5-5', isReported: true } },
      source: 'session', subject: { platform: 'claude-code', sessionId },
    },
    start,
    learnings: [],
  };
}

const session = (sessionId: string) => ({ platform: 'claude-code', sessionId });
const sessionIds = (failures: readonly DigestFailure[]) => failures.map(({ failure }) => ('sessionId' in failure.subject ? failure.subject.sessionId : failure.subject.runId));

describe('picking the failures a self-improvement starts from', () => {
  it('keeps the scorer\'s failures whose start commit this checkout has, each subject once, newest first', () => {
    const picked = SelfImprovement.pick({
      failures: [
        failing('s2', { commit: HERE }),
        failing('s1', { commit: HERE }),
        failing('s1', { refused: 'not_recorded' }, { judge: 'human' }),
        failing('s9', { commit: HERE }, { scorer: 'test-quality' }),
      ],
      scorer: 'review-quality',
      tasks: new Map(),
      hasCommit: (commit) => commit === HERE,
    });

    expect(sessionIds(picked.failures)).toEqual(['s2', 's1']);
    expect(picked.covered).toEqual([]);
    expect(picked.refused).toEqual([]);
  });

  it('lists a failure a task already names as covered by that task, once, instead of picking it', () => {
    const task = 'benchmarks/regressions/tasks/missed-null-check.yaml';
    const picked = SelfImprovement.pick({
      failures: [failing('s3', { commit: HERE }), failing('s1', { commit: HERE }), failing('s1', { commit: HERE }, { judge: 'human' })],
      scorer: 'review-quality',
      tasks: new Map([[canonicalJson(session('s1')), task]]),
      hasCommit: () => true,
    });

    expect(sessionIds(picked.failures)).toEqual(['s3']);
    expect(picked.covered).toEqual([task]);
  });

  it('refuses a failure no commit holds the start of, or whose commit this checkout lacks, saying why', () => {
    const picked = SelfImprovement.pick({
      failures: [
        failing('dirty', { refused: 'tracked_changes' }),
        failing('unseen', { refused: 'not_recorded' }),
        failing('other-project', { commit: ELSEWHERE }),
      ],
      scorer: 'review-quality',
      tasks: new Map(),
      hasCommit: (commit) => commit === HERE,
    });

    expect(picked.failures).toEqual([]);
    expect(picked.refused).toEqual([
      { subject: session('dirty'), why: 'tracked_changes' },
      { subject: session('unseen'), why: 'not_recorded' },
      { subject: session('other-project'), why: 'not_in_checkout' },
    ]);
  });
});

describe('whether a run improves the harness', () => {
  it('needs two failures to start from, or one more for a proposal already open, never one beside a task that landed', () => {
    expect(SelfImprovement.isReady({ startable: 2, hasProposal: false })).toBe(true);
    expect(SelfImprovement.isReady({ startable: 1, hasProposal: true })).toBe(true);
    expect(SelfImprovement.isReady({ startable: 1, hasProposal: false })).toBe(false);
    expect(SelfImprovement.isReady({ startable: 0, hasProposal: true })).toBe(false);
  });
});

describe('proposing a change', () => {
  const roots: string[] = [];
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co' },
  }).toString().trim();

  it('refuses a regression task the suite cannot run, naming it, and pushes nothing', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-improvement-propose-')));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const team = path.join(root, 'team');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, team);
    fs.mkdirSync(path.join(team, 'benchmarks/regressions/tasks'), { recursive: true });
    fs.writeFileSync(path.join(team, 'benchmarks/regressions/suite.yaml'), 'schemaVersion: v1alpha1\nname: regressions\nrepo: https://github.com/acme/auth-service.git\ndefaults: { tool: claude }\nmatrix: { team: [main, pulled] }\ntimeout: 2h\n');
    git(team, 'add', '-A');
    git(team, 'commit', '-qm', 'suite');
    git(team, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(team, 'benchmarks/regressions/tasks/missed-null-check.yaml'), 'schemaVersion: v1alpha1\ntitle: Missed a null check\nprompt: Review the change.\n');
    const errors: string[] = [];
    const { log } = await import('../utils/logger.js');
    vi.spyOn(log, 'error').mockImplementation((message: string) => { errors.push(message); });

    await SelfImprovement.propose({ team, branch: 'teamai/self-improvement/review-quality' });

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/^invalid_task: The suite cannot run these regression tasks, so nothing was proposed\. Fix them in .+:\nbenchmarks\/regressions\/tasks\/missed-null-check\.yaml:1: field "startingCommit": /)]);
    expect(git(team, 'ls-remote', '--heads', 'origin')).not.toContain('teamai/self-improvement/review-quality');
  });
});
