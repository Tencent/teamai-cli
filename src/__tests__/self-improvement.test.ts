import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DigestFailure } from '../digest-failures.js';
import { SelfImprovement } from '../self-improvement.js';
import { parseWorkflow } from '../workflow/parse.js';
import { LocalConfigSchema, type LocalConfig } from '../types.js';
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

  it('starts from a subject\'s recorded failure when a newer hand label of it has no start recorded', () => {
    const picked = SelfImprovement.pick({
      failures: [
        failing('s1', { refused: 'not_recorded' }, { judge: 'human' }),
        failing('s2', { refused: 'not_recorded' }, { judge: 'human' }),
        failing('s1', { commit: HERE }),
        failing('s2', { commit: HERE }),
      ],
      scorer: 'review-quality',
      tasks: new Map(),
      hasCommit: (commit) => commit === HERE,
    });

    expect(sessionIds(picked.failures)).toEqual(['s1', 's2']);
    expect(picked.failures.map(({ start }) => start)).toEqual([{ commit: HERE }, { commit: HERE }]);
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
  const parsed = parseWorkflow('workflows/teamai-self-improvement.yaml', fs.readFileSync(path.join(process.cwd(), 'workflows/teamai-self-improvement.yaml'), 'utf8'));
  const workflow = parsed.ok ? parsed.definition : undefined;
  const inputs = { scorer: 'review-quality', suite: 'benchmarks/regressions' };
  const improvement = (startable: number, hasProposal: boolean) => ({
    failures: Array.from({ length: startable }, (_, index) => failing(`s${index}`, { commit: HERE })), covered: ['benchmarks/regressions/tasks/landed.yaml'], refused: [], hasProposal,
  });

  it('needs, in the default workflow, two failures to start from, or one more for a proposal already open, never one beside a task that landed', () => {
    expect(workflow).toBeDefined();
    expect([[2, false], [1, true], [1, false], [0, true]].map(([startable, hasProposal]) => (
      SelfImprovement.wouldImprove(workflow, { inputs, improvement: improvement(Number(startable), Boolean(hasProposal)) })
    ))).toEqual([true, true, false, false]);
  });

  it('never improves from a workflow with no step that delivers a pull request', () => {
    const own = parseWorkflow('workflows/teamai-self-improvement.yaml', 'schemaVersion: v1alpha1\nname: teamai-self-improvement\ndescription: Only plans.\nsteps:\n  - id: plan\n    command: ./plan.sh\n');
    expect(SelfImprovement.wouldImprove(own.ok ? own.definition : undefined, { inputs, improvement: improvement(3, true) })).toBe(false);
  });
});

describe('the tasks that already cover a failure', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co' },
  }).toString().trim();
  const task = (sessionId: string) => `schemaVersion: v1alpha1\ntitle: t\nprompt: p\nstartingCommit: ${HERE}\nsuccessCriteria: s\nsource: { platform: claude-code, sessionId: ${sessionId} }\n`;
  const commit = (dir: string, files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', message);
  };

  /** A team origin whose main has a task of the suite and one of another suite, and the member's clone of it from before both. */
  const team = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-improvement-covered-')));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const writer = path.join(root, 'writer');
    const member = path.join(root, 'member');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, writer);
    commit(writer, { 'README.md': 'team\n' }, 'start');
    git(writer, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, member);
    commit(writer, { 'benchmarks/regressions/tasks/landed.yaml': task('s1'), 'benchmarks/web/tasks/other.yaml': task('s3') }, 'tasks');
    git(writer, 'push', '-q', 'origin', 'main');
    const config: LocalConfig = { ...LocalConfigSchema.parse({ repo: { localPath: member, remote: origin }, username: 'member' }), dataHome: path.join(root, 'data') };
    return { writer, member: config };
  };

  it('lists the suite\'s tasks on origin\'s default branch and on the proposal, by the subject each names', async () => {
    const { writer, member } = team();
    git(writer, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
    commit(writer, { 'benchmarks/regressions/tasks/proposed.yaml': task('s2') }, 'proposal');
    git(writer, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(true);
    expect(Object.fromEntries(covered.tasks)).toEqual({
      [canonicalJson(session('s1'))]: 'benchmarks/regressions/tasks/landed.yaml',
      [canonicalJson(session('s2'))]: 'benchmarks/regressions/tasks/proposed.yaml',
    });
  });

  it('says there is no proposal once main holds the branch, as after its pull request merged and kept it', async () => {
    const { writer, member } = team();
    git(writer, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
    commit(writer, { 'benchmarks/regressions/tasks/proposed.yaml': task('s2') }, 'proposal');
    git(writer, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');
    git(writer, 'checkout', '-q', 'main');
    git(writer, 'merge', '-q', '--no-ff', '-m', 'merge the proposal', 'teamai/self-improvement/review-quality');
    git(writer, 'push', '-q', 'origin', 'main');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(false);
    expect(Object.keys(Object.fromEntries(covered.tasks))).toContain(canonicalJson(session('s2')));
  });

  it('says there is no proposal once main has each task the branch adds, as a squash merge leaves a kept branch', async () => {
    const { writer, member } = team();
    git(writer, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
    commit(writer, { 'benchmarks/regressions/tasks/proposed.yaml': task('s2') }, 'proposal');
    git(writer, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');
    git(writer, 'checkout', '-q', 'main');
    git(writer, 'merge', '-q', '--squash', 'teamai/self-improvement/review-quality');
    git(writer, 'commit', '-qm', 'the proposal, squashed');
    git(writer, 'push', '-q', 'origin', 'main');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(false);
  });

  it('covers no failure with a task of a squash-merged proposal that main deleted since', async () => {
    const { writer, member } = team();
    git(writer, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
    commit(writer, { 'benchmarks/regressions/tasks/proposed.yaml': task('s2') }, 'proposal');
    git(writer, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');
    git(writer, 'checkout', '-q', 'main');
    git(writer, 'merge', '-q', '--squash', 'teamai/self-improvement/review-quality');
    git(writer, 'commit', '-qm', 'the proposal, squashed');
    git(writer, 'rm', '-q', 'benchmarks/regressions/tasks/proposed.yaml');
    git(writer, 'commit', '-qm', 'drop the task');
    git(writer, 'push', '-q', 'origin', 'main');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(false);
    expect([...covered.tasks.values()]).toEqual(['benchmarks/regressions/tasks/landed.yaml']);
  });

  it('covers no failure with a task of a merged proposal that main deleted since', async () => {
    const { writer, member } = team();
    git(writer, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
    commit(writer, { 'benchmarks/regressions/tasks/proposed.yaml': task('s2') }, 'proposal');
    git(writer, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');
    git(writer, 'checkout', '-q', 'main');
    git(writer, 'merge', '-q', '--no-ff', '-m', 'merge the proposal', 'teamai/self-improvement/review-quality');
    git(writer, 'rm', '-q', 'benchmarks/regressions/tasks/proposed.yaml');
    git(writer, 'commit', '-qm', 'drop the task');
    git(writer, 'push', '-q', 'origin', 'main');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(false);
    expect([...covered.tasks.values()]).toEqual(['benchmarks/regressions/tasks/landed.yaml']);
  });

  it('says there is no proposal when origin has no such branch', async () => {
    const { member } = team();

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    if (covered === 'busy') throw new Error('the sync lock was free');
    expect(covered.hasProposal).toBe(false);
    expect([...covered.tasks.values()]).toEqual(['benchmarks/regressions/tasks/landed.yaml']);
  });

  it('reads nothing while a teamai pull or push holds the team repo, and leaves its refs as they were', async () => {
    const { member } = team();
    const lock = path.join(member.dataHome ?? '', '.sync-lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'pull' }));
    const before = git(member.repo.localPath, 'rev-parse', 'refs/remotes/origin/main');

    const covered = await SelfImprovement.coveringTasks(member, { suite: 'benchmarks/regressions', proposal: 'teamai/self-improvement/review-quality' });

    expect(covered).toBe('busy');
    expect(git(member.repo.localPath, 'rev-parse', 'refs/remotes/origin/main')).toBe(before);
  });
});
