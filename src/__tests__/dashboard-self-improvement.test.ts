import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The team's reports checkout is refreshed from origin before it is read; these fixtures have no reports origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import type { AgentObservation } from '../agent-observation.js';
import { syncTeamDefinitions } from '../benchmark/suite-cache.js';
import { selfImprovementView } from '../dashboard/self-improvement.js';
import type { ScoreLabel } from '../scorers/label.js';
import { getReportsDir, type LocalConfig } from '../types.js';

const NOW = new Date('2026-03-20T12:00:00Z');
const originalHome = process.env.HOME;
let root = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-self-improvement-')));
  process.env.HOME = path.join(root, 'home');
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A project checkout with one commit, which the failures it records start at. */
function project(): { dir: string; commit: string } {
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

/** A team clone of a bare origin, with the regression suite `benchmarks/regressions` and no task. */
function team(projectRoot: string): { config: LocalConfig; repo: string; origin: string } {
  const origin = path.join(root, 'team', 'origin.git');
  const repo = path.join(root, 'team', 'repo');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  write(path.join(repo, 'benchmarks/regressions/suite.yaml'), [
    'schemaVersion: v1alpha1', 'name: regressions', 'repo: https://github.com/acme/auth-service.git',
    'defaults: { tool: claude }', 'matrix: { team: [main, pulled] }', 'repetitions: 1', 'timeout: 1h', '',
  ].join('\n'));
  commit(repo, 'Add the regression suite');
  const config: LocalConfig = { repo: { localPath: repo, remote: origin, kind: 'git' }, username: 'alice', scope: 'project', additionalRoles: [], projectRoot, dataHome: path.join(root, 'data') };
  return { config, repo, origin };
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  return git(repo, 'rev-parse', 'HEAD');
}

/** A regression task of the suite made from the session `sessionId`, starting at `startingCommit`. */
function task(repo: string, id: string, sessionId: string, startingCommit: string): void {
  write(path.join(repo, `benchmarks/regressions/tasks/${id}.yaml`), [
    'schemaVersion: v1alpha1', `title: ${id}`, 'prompt: Review the change.', `startingCommit: ${startingCommit}`,
    'successCriteria: Flags the missing null check.', `source: { platform: claude, sessionId: ${sessionId} }`, '',
  ].join('\n'));
}

/** Pushes the proposal a run makes for review-quality from session `new-1` to origin, and returns its head. */
function proposal(origin: string, startingCommit: string): string {
  const elsewhere = path.join(root, 'proposer');
  git(root, 'clone', '-q', origin, elsewhere);
  git(elsewhere, 'checkout', '-q', '-b', 'teamai/self-improvement/review-quality');
  write(path.join(elsewhere, 'agents/reviewer.md'), '# Reviewer\nRead the whole diff first.\n');
  task(elsewhere, 'skipped-the-diff', 'new-1', startingCommit);
  git(elsewhere, 'add', '-A');
  git(elsewhere, 'commit', '-q', '-m', '[teamai] Add agents/reviewer.md and 1 more file from alice');
  git(elsewhere, 'push', '-q', 'origin', 'teamai/self-improvement/review-quality');
  return git(elsewhere, 'rev-parse', 'HEAD');
}

/**
 * The record a regression suite run publishes: each task of `trials` run once on the arm `main`, the team's default
 * branch at `main`, and once on `pulled`, the team revision `pulled` the job pinned.
 */
function publishBenchmark(config: LocalConfig, { run, main, pulled, trials }: { run: string; main: string; pulled: string; trials: Record<string, { main: 'passed' | 'failed'; pulled: 'passed' | 'failed' }> }): void {
  const arms = [
    { name: 'main', tool: 'claude', source: 'team', team: { kind: 'ref', ref: 'main', revision: main } },
    { name: 'pulled', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: pulled } },
  ];
  let order = 0;
  write(path.join(getReportsDir(config), 'benchmarks', 'runs', `${run}.json`), JSON.stringify({
    schemaVersion: 1, run, outcome: 'succeeded', teamaiVersion: '1.0.0', startedAt: '2026-03-19T09:00:00.000Z', finishedAt: '2026-03-19T10:00:00.000Z', username: 'ci',
    workflow: { name: 'teamai-benchmark', origin: { source: 'default', teamaiVersion: '1.0.0' }, sourceHash: 'w'.repeat(64) },
    suite: { name: 'regressions', sourceHash: 's1' }, repetitions: 1, baselineTeamRevision: pulled, scorers: [],
    tasks: Object.keys(trials).map((id) => ({ id, startingCommit: 'a'.repeat(40), sourceHash: `task-${id}`, baseline: 'valid' })),
    arms,
    trials: Object.entries(trials).flatMap(([taskId, results]) => (['main', 'pulled'] as const).map((arm) => ({
      task: taskId, arm, repetition: 1, order: order++, step: `trials.r1.${taskId}.${arm}.prompt`, result: results[arm],
    }))),
  }));
}

function publishLabels(config: LocalConfig, labels: ScoreLabel[]): void {
  write(path.join(getReportsDir(config), 'scores', 'bob', '2026-03.jsonl'), labels.map((scored) => `${JSON.stringify(scored)}\n`).join(''));
}

const judge = { kind: 'model', tool: 'claude', model: { reported: 'claude-haiku-5-5' }, isolation: 'verified', access: 'read' } as const;

/** The work of a session as its agent recorded it: the project commit it started at, and the team revision it ran on. */
function agent(start: { commit: string; dirty?: boolean } | undefined, teamRevision?: string): AgentObservation {
  return {
    v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local',
    ...(start ? { project: { commit: start.commit, dirty: start.dirty ?? false } } : {}),
    ...(teamRevision ? { team: { revision: teamRevision, localChanges: false } } : {}),
  };
}

function label(sessionId: string, { passed = false, scoredAt = '2026-03-18T10:00:00.000Z', recorded }: { passed?: boolean; scoredAt?: string; recorded?: AgentObservation } = {}): ScoreLabel {
  return {
    scorer: 'review-quality', rubric: { sourceHash: 'rubric-1' }, label: passed ? 'good' : 'missed-bug', score: passed ? 1 : 0, passed, judge,
    scoredAt, source: 'session', subject: { platform: 'claude', sessionId }, ...recorded ? { agent: recorded } : {},
  };
}

describe('dashboard self-improvement', () => {
  it('shows for each scorer the failures a run would start from, the ones a task covers, and why the rest cannot become one', async () => {
    const start = project();
    const { config, repo } = team(start.dir);
    task(repo, 'missed-null-check', 'covered', start.commit);
    commit(repo, 'Add a regression task');
    await syncTeamDefinitions(config);
    publishLabels(config, [
      label('covered', { recorded: agent({ commit: start.commit }) }),
      label('new-1', { recorded: agent({ commit: start.commit }) }),
      label('new-2', { recorded: agent({ commit: start.commit }) }),
      label('dirty', { recorded: agent({ commit: start.commit, dirty: true }) }),
      label('unseen'),
      label('elsewhere', { recorded: agent({ commit: 'e'.repeat(40) }) }),
      label('passed', { passed: true, recorded: agent({ commit: start.commit }) }),
    ]);

    const view = await selfImprovementView({ config, now: NOW, refresh: false });

    expect(view.scorers).toEqual([expect.objectContaining({
      scorer: 'review-quality',
      stats: { n: 7, passed: 1, failed: 6, rate: 1 / 7 },
      startable: 2,
      covered: ['benchmarks/regressions/tasks/missed-null-check.yaml'],
      refused: { tracked_changes: 1, not_recorded: 1, not_in_checkout: 1 },
      isReady: true,
      command: 'teamai self-improvement run review-quality --tools default=claude --sandbox',
    })]);
  });

  it('lists a change that landed on the default branch with the assets it changed, the tasks it added and the scorer\'s pass rate before and after it', async () => {
    const start = project();
    const { config, repo } = team(start.dir);
    const before = git(repo, 'rev-parse', 'HEAD');
    write(path.join(repo, 'skills/review/SKILL.md'), '# Review\nCheck every input for null.\n');
    task(repo, 'missed-null-check', 'old-1', start.commit);
    task(repo, 'missed-null-check-2', 'old-2', start.commit);
    const landed = commit(repo, 'Review: check every input for null');
    write(path.join(repo, 'rules/style.md'), '# Style\n');
    commit(repo, 'An unrelated change');
    await syncTeamDefinitions(config);
    publishLabels(config, [
      label('old-1', { scoredAt: '2026-03-01T10:00:00.000Z', recorded: agent({ commit: start.commit }, before) }),
      label('old-2', { scoredAt: '2026-03-02T10:00:00.000Z', recorded: agent({ commit: start.commit }, before) }),
      label('old-3', { passed: true, scoredAt: '2026-03-03T10:00:00.000Z', recorded: agent({ commit: start.commit }, before) }),
      label('after-1', { passed: true, scoredAt: '2026-03-15T10:00:00.000Z', recorded: agent({ commit: start.commit }, landed) }),
      label('after-2', { passed: true, scoredAt: '2026-03-16T10:00:00.000Z', recorded: agent({ commit: start.commit }, landed) }),
    ]);

    // A later run compares its own proposal against the default branch, which has the change: that proves another change.
    publishBenchmark(config, { run: 'r00000000000000a2', main: landed, pulled: 'f'.repeat(40), trials: { 'missed-null-check': { main: 'passed', pulled: 'passed' } } });

    const view = await selfImprovementView({ config, now: NOW, refresh: false });

    expect(view.changes).toEqual([{
      state: 'landed',
      scorer: 'review-quality',
      commit: landed,
      title: 'Review: check every input for null',
      at: expect.any(String),
      files: ['benchmarks/regressions/tasks/missed-null-check-2.yaml', 'benchmarks/regressions/tasks/missed-null-check.yaml', 'skills/review/SKILL.md'],
      tasks: ['benchmarks/regressions/tasks/missed-null-check-2.yaml', 'benchmarks/regressions/tasks/missed-null-check.yaml'],
      impact: {
        before: { n: 3, passed: 1, failed: 2, rate: 1 / 3 },
        after: { n: 2, passed: 2, failed: 0, rate: 1 },
        notRecorded: { n: 0, passed: 0, failed: 0, rate: null },
      },
    }]);
  });

  it('lists the proposal a run pushed and no one merged yet, with what it changes against the default branch', async () => {
    const start = project();
    const { config, repo, origin } = team(start.dir);
    const head = proposal(origin, start.commit);
    write(path.join(repo, 'rules/style.md'), '# Style\n');
    commit(repo, 'A change on main since');
    publishLabels(config, [label('new-1', { recorded: agent({ commit: start.commit }) })]);

    const view = await selfImprovementView({ config, now: NOW, refresh: true });

    expect(view.changes).toEqual([{
      state: 'proposed',
      scorer: 'review-quality',
      branch: 'teamai/self-improvement/review-quality',
      commit: head,
      title: '[teamai] Add agents/reviewer.md and 1 more file from alice',
      at: expect.any(String),
      files: ['agents/reviewer.md', 'benchmarks/regressions/tasks/skipped-the-diff.yaml'],
      tasks: ['benchmarks/regressions/tasks/skipped-the-diff.yaml'],
      request: { kind: 'unknown' },
    }]);
    // As self-improvement plan reads the proposal's branch, its tasks cover their failures: the next run updates it.
    expect(view.scorers).toEqual([expect.objectContaining({ startable: 0, covered: ['benchmarks/regressions/tasks/skipped-the-diff.yaml'] })]);
  });

  it('shows with a proposal the regression suite run that pinned it: each task on the default branch and on the proposal', async () => {
    const start = project();
    const { config, repo, origin } = team(start.dir);
    const head = proposal(origin, start.commit);
    publishLabels(config, [label('new-1', { recorded: agent({ commit: start.commit }) })]);
    publishBenchmark(config, { run: 'r00000000000000a1', main: git(repo, 'rev-parse', 'HEAD'), pulled: head, trials: { 'skipped-the-diff': { main: 'failed', pulled: 'passed' }, 'missed-null-check': { main: 'passed', pulled: 'passed' } } });

    const view = await selfImprovementView({ config, now: NOW, refresh: true });

    expect(view.changes[0]?.proof).toEqual({
      run: 'r00000000000000a1',
      source: 'reported',
      suite: 'regressions',
      startedAt: '2026-03-19T09:00:00.000Z',
      comparisons: [{
        from: { arm: 'main', tool: 'claude' }, to: { arm: 'pulled', tool: 'claude' }, pairs: 2,
        rates: { from: { passed: 1, planned: 2 }, to: { passed: 2, planned: 2 } },
        difference: expect.objectContaining({ value: 0.5 }),
        tasks: [
          { task: 'skipped-the-diff', from: { passed: 0, planned: 1 }, to: { passed: 1, planned: 1 } },
          { task: 'missed-null-check', from: { passed: 1, planned: 1 }, to: { passed: 1, planned: 1 } },
        ],
      }],
    });
  });

  it('says what runs the loop: the workflow, the CI jobs that run and prove it, its regression suites and its last runs', async () => {
    const start = project();
    const { config, repo } = team(start.dir);
    task(repo, 'missed-null-check', 'covered', start.commit);
    write(path.join(repo, 'benchmarks/regressions/tasks/hand-written.yaml'), [
      'schemaVersion: v1alpha1', 'title: hand-written', 'prompt: Review the change.', `startingCommit: ${start.commit}`, 'successCriteria: Flags the bug.', '',
    ].join('\n'));
    write(path.join(repo, '.github/workflows/self-improvement.yml'), 'jobs:\n  improve:\n    steps:\n      - run: npx teamai-cli self-improvement run review-quality --tools default=claude --sandbox\n');
    write(path.join(repo, '.github/workflows/regressions.yml'), 'jobs:\n  prove:\n    steps:\n      - run: npx teamai-cli benchmark run regressions --team-ref "$HEAD_REF"\n');
    commit(repo, 'Run the loop in CI');
    await syncTeamDefinitions(config);
    write(path.join(getReportsDir(config), 'workflows', 'runs', 'r00000000000000b1.json'), JSON.stringify({
      schemaVersion: 'v1alpha1', run: 'r00000000000000b1', workflow: 'teamai-self-improvement', sourceHash: 'f'.repeat(64), phase: 'end', status: 'succeeded',
      startedAt: '2026-03-19T06:00:00.000Z', endedAt: '2026-03-19T06:20:00.000Z', username: 'ci', publishedAt: '2026-03-19T06:21:00.000Z', steps: [],
    }));

    const view = await selfImprovementView({ config, now: NOW, refresh: false });

    expect(view.setup).toEqual({
      workflow: { source: 'default' },
      jobs: { improve: '.github/workflows/self-improvement.yml', proof: '.github/workflows/regressions.yml' },
      suites: [{ name: 'regressions', path: 'benchmarks/regressions', tasks: 2, regressions: 1 }],
    });
    expect(view.runs).toEqual([expect.objectContaining({ run: 'r00000000000000b1', status: 'succeeded', startedAt: '2026-03-19T06:00:00.000Z', source: 'reported' })]);
  });
});
