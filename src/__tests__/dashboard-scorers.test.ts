import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The team's reports checkout is refreshed from origin before it is read; these fixtures have no origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import type { AgentObservation } from '../agent-observation.js';
import { HttpError } from '../dashboard/http.js';
import { parseScorerQuery, scorerResults } from '../dashboard/scorers.js';
import { scorerSourceHash, syncScorerDefinitions } from '../scorers/cache.js';
import type { ScoreLabel } from '../scorers/label.js';
import { getReportsDir, type DashboardEvent, type LocalConfig } from '../types.js';
import { readRun, runFilePath } from '../workflow/store.js';

const NOW = new Date('2026-03-20T12:00:00Z');
const originalHome = process.env.HOME;
let root = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-scorers-')));
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

/** A team clone with commits A, B (child of A) and C (child of B). */
function team(): { config: LocalConfig; commits: [string, string, string] } {
  const repo = path.join(root, 'team', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const commits = ['A', 'B', 'C'].map((name) => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
  });
  const [A, B, C] = commits;
  if (!A || !B || !C) throw new Error('fixture commits missing');
  const config: LocalConfig = { repo: { localPath: repo, remote: 'local', kind: 'git' }, username: 'alice', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  return { config, commits: [A, B, C] };
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function publishLabels(config: LocalConfig, member: string, labels: ScoreLabel[]): void {
  write(path.join(getReportsDir(config), 'scores', member, '2026-03.jsonl'), labels.map((label) => `${JSON.stringify(label)}\n`).join(''));
}

function publishRecord(config: LocalConfig, record: Record<string, unknown>): void {
  write(path.join(getReportsDir(config), 'workflows', 'runs', `${String(record.run)}.json`), JSON.stringify({
    schemaVersion: 'v1alpha1', workflow: 'review', sourceHash: 'f'.repeat(64), phase: 'end', status: 'succeeded',
    startedAt: '2026-03-10T00:00:00.000Z', username: 'alice', publishedAt: '2026-03-10T00:10:00.000Z', ...record,
  }));
}

const judge = { kind: 'model', tool: 'claude', model: { reported: 'claude-haiku-5-5' }, isolation: 'verified', access: 'read' } as const;

function workflowLabel(runId: string, overrides: Partial<Extract<ScoreLabel, { source: 'workflow' }>> = {}): ScoreLabel {
  return {
    scorer: 'diff-quality', rubric: { sourceHash: 'rubric-1' }, label: 'good', score: 1, passed: true, judge,
    scoredAt: '2026-03-18T10:00:00.000Z', source: 'workflow', subject: { runId, step: 'implement', pass: 1 }, ...overrides,
  };
}

function sessionLabel(sessionId: string, overrides: Partial<Extract<ScoreLabel, { source: 'session' }>> = {}): ScoreLabel {
  return {
    scorer: 'review-quality', rubric: { sourceHash: 'rubric-1' }, label: 'good', score: 1, passed: true, judge,
    scoredAt: '2026-03-18T10:00:00.000Z', source: 'session', subject: { platform: 'claude', sessionId }, ...overrides,
  };
}

const observation = (tool: string, revision?: string): AgentObservation => ({
  v: 1, definition: { name: 'implementer' }, tool: { name: tool }, teamai: '1.0.0', driver: 'local',
  ...(revision ? { team: { revision, localChanges: false } } : {}),
});

describe('dashboard scorer results', () => {
  it('groups a workflow label by the agent of the pass it judges, and a pre-#1176 record by its definition only', async () => {
    const { config } = team();
    publishRecord(config, { run: 'r0000000000000001', steps: [{ step: 'implement', pass: 1, agent: observation('codex') }, { step: 'implement', pass: 2, agent: observation('claude') }] });
    publishRecord(config, { run: 'r0000000000000002', steps: [{ step: 'implement', pass: 1, agent: 'implementer' }] });
    publishLabels(config, 'bob', [workflowLabel('r0000000000000001'), workflowLabel('r0000000000000002')]);
    const byTool = await scorerResults({ config, query: { windowDays: 30, groupBy: 'tool' }, now: NOW });
    expect(byTool.selected?.groups?.map((group) => [group.kind === 'value' ? group.value : group.kind, group.stats.n])).toEqual([['codex', 1], ['not recorded', 1]]);
    const byDefinition = await scorerResults({ config, query: { windowDays: 30, groupBy: 'definition' }, now: NOW });
    expect(byDefinition.selected?.groups?.map((group) => [group.kind === 'value' ? group.value : group.kind, group.stats.n])).toEqual([['implementer', 2]]);
  });

  it('leaves out the labels of a benchmark run', async () => {
    const { config } = team();
    publishRecord(config, { run: 'r0000000000000001', steps: [{ step: 'implement', pass: 1, agent: observation('claude') }] });
    publishRecord(config, { run: 'r0000000000000002', benchmark: { suite: { sourceHash: 'b'.repeat(64) }, trials: [] }, steps: [{ step: 'implement', pass: 1, agent: observation('codex') }] });
    publishLabels(config, 'bob', [workflowLabel('r0000000000000001'), workflowLabel('r0000000000000002', { passed: false })]);
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(view.selected?.cohort.stats).toEqual({ n: 1, passed: 1, failed: 0, rate: 1 });
  });

  it('leaves out the labels of a benchmark run whose run file is also on this machine', async () => {
    const { config } = team();
    const runId = 'r0000000000000002';
    publishRecord(config, { run: runId, benchmark: { suite: { sourceHash: 'b'.repeat(64) }, trials: [] }, steps: [{ step: 'implement', pass: 1, agent: observation('codex') }] });
    write(runFilePath(config, runId), JSON.stringify({
      schemaVersion: 'v1alpha1', id: runId, name: 'review', revision: 1, status: 'succeeded', startedAt: 1, steps: [], settledAttempts: [],
      definition: { schemaVersion: 'v1alpha1', name: 'review', description: 'Review.', steps: [{ id: 'implement', prompt: 'p' }] },
    }));
    expect(await readRun(config, runId)).toMatchObject({ id: runId });
    publishLabels(config, 'bob', [workflowLabel(runId, { passed: false })]);
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(view.scorers).toEqual([]);
  });

  it('splits at a team commit with this clone\'s ancestry, and refuses a commit the clone does not have', async () => {
    const { config, commits: [A, B, C] } = team();
    const labels = [A, B, C, undefined].map((revision, index) => sessionLabel(`s-${index}`, { agent: observation('claude', revision) }));
    publishLabels(config, 'bob', labels);
    const view = await scorerResults({ config, query: { windowDays: 30, commit: B.slice(0, 10) }, now: NOW });
    expect(view.selected?.split).toMatchObject({ commit: B, before: { n: 1 }, after: { n: 2 }, notRecorded: { n: 1 } });
    const refused = await scorerResults({ config, query: { windowDays: 30, commit: 'd'.repeat(40) }, now: NOW }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 400, message: expect.stringContaining('dddddddddd') });
  });

  it('names the pushed session of a failing label, and answers with no reasoning, transcript, prompt or native session id', async () => {
    const { config } = team();
    publishLabels(config, 'bob', [sessionLabel('native-7f3a91', { passed: false, label: 'poor', score: 0 })]);
    write(path.join(config.repo.localPath, 'sessions', 'repos', 'github.com%2Facme%2Fapp', '_index.json'), JSON.stringify({
      version: 1, repoIdentity: 'github.com/acme/app', updatedAt: '2026-03-18T00:00:00.000Z',
      sessions: [{ sessionName: 'fix-login-flow', author: 'bob', platform: 'claude', title: 'TITLE-SECRET', cwd: '/private/work', repoIdentity: 'github.com/acme/app', messageCount: 3, createdAt: '2026-03-17T00:00:00.000Z', updatedAt: '2026-03-18T00:00:00.000Z', status: 'active', sessionId: 'native-7f3a91' }],
    }));
    write(path.join(config.repo.localPath, 'sessions', 'repos', 'github.com%2Facme%2Fapp', 'bob', 'fix-login-flow.jsonl'), 'TRANSCRIPT-SECRET\n');
    write(path.join(config.dataHome ?? '', 'scores', 'reasoning', 'x.md'), 'REASONING-SECRET');
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(view.selected?.failing).toEqual({ total: 1, labels: [{ author: 'bob', scoredAt: '2026-03-18T10:00:00.000Z', label: 'poor', source: 'session', platform: 'claude', sessionName: 'fix-login-flow' }] });
    expect(JSON.stringify(view)).not.toMatch(/native-7f3a91|TITLE-SECRET|private\/work|TRANSCRIPT-SECRET|REASONING-SECRET|isolation|access/);
  });

  it('names a failing label\'s session archived on teamai-reports, and one archived on the default branch before', async () => {
    const { config } = team();
    publishLabels(config, 'bob', [
      sessionLabel('on-reports', { passed: false, label: 'poor', score: 0, scoredAt: '2026-03-18T11:00:00.000Z' }),
      sessionLabel('on-main', { passed: false, label: 'poor', score: 0 }),
    ]);
    const archive = (dir: string, sessionId: string, sessionName: string) => write(path.join(dir, 'sessions', '_unattributed', '_index.json'), JSON.stringify({
      version: 1, repoIdentity: null, updatedAt: '2026-03-18T00:00:00.000Z',
      sessions: [{ sessionName, author: 'bob', platform: 'claude', title: 't', cwd: '/w', repoIdentity: null, messageCount: 2, createdAt: '2026-03-17T00:00:00.000Z', updatedAt: '2026-03-18T00:00:00.000Z', status: 'active', sessionId }],
    }));
    archive(getReportsDir(config), 'on-reports', 'add-retries');
    archive(config.repo.localPath, 'on-main', 'plan-the-release');
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(view.selected?.failing?.labels).toMatchObject([{ sessionName: 'add-retries' }, { sessionName: 'plan-the-release' }]);
  });

  it('pairs hand labels with a rubric by the values its cached scorer lists, not only those its labels stored', async () => {
    const { config } = team();
    const scorer = '---\nlabels:\n  - { value: good, score: 1, description: Fixed it }\n  - { value: missed-bug, score: 0, description: Left the bug }\npassingScore: 1\n---\nJudge whether the session fixed the bug.\n';
    write(path.join(config.repo.localPath, 'scorers', 'review-quality.md'), scorer);
    await syncScorerDefinitions(config);
    const cached = { sourceHash: scorerSourceHash(scorer) };
    publishLabels(config, 'bob', [
      sessionLabel('one', { rubric: cached }),
      sessionLabel('two', { rubric: cached }),
      sessionLabel('one', { judge: { kind: 'human' }, label: 'missed-bug', score: 0, passed: false }),
      sessionLabel('two', { judge: { kind: 'human' } }),
    ]);
    const opened = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    const cohort = opened.scorers[0]?.cohorts.find((one) => one.rubric.sourceHash === cached.sourceHash && one.judge.kind === 'model');
    const view = await scorerResults({ config, query: { windowDays: 30, scorer: 'review-quality', cohort: cohort?.id }, now: NOW });
    expect(view.selected?.agreement.judges).toMatchObject([{ labels: 2, paired: 2, agree: 1, judgePassedHumanFailed: 1 }]);
  });

  it('pairs hand labels with an older rubric by the values the scorer listed at its team revision', async () => {
    const { config } = team();
    const repo = config.repo.localPath;
    const rubric = (prompt: string) => `---\nlabels:\n  - { value: good, score: 1, description: Fixed it }\n  - { value: missed-bug, score: 0, description: Left the bug }\npassingScore: 1\n---\n${prompt}\n`;
    const commit = (prompt: string) => {
      write(path.join(repo, 'scorers', 'review-quality.md'), rubric(prompt));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', prompt);
      return { sourceHash: scorerSourceHash(rubric(prompt)), teamRevision: git(repo, 'rev-parse', 'HEAD') };
    };
    const first = commit('Judge whether the session fixed the bug.');
    const second = commit('Judge whether the session fixed the bug. Read the tests it ran.');
    commit('Judge whether the session fixed the bug and added a test.');
    await syncScorerDefinitions(config);
    publishLabels(config, 'bob', [
      sessionLabel('one', { rubric: second }),
      sessionLabel('two', { rubric: second }),
      sessionLabel('one', { rubric: first, judge: { kind: 'human' }, label: 'missed-bug', score: 0, passed: false }),
      sessionLabel('two', { rubric: first, judge: { kind: 'human' } }),
    ]);
    const opened = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    const cohort = opened.scorers[0]?.cohorts.find((one) => one.rubric.sourceHash === second.sourceHash && one.judge.kind === 'model');
    const view = await scorerResults({ config, query: { windowDays: 30, scorer: 'review-quality', cohort: cohort?.id }, now: NOW });
    expect(view.selected?.agreement.judges).toMatchObject([{ labels: 2, paired: 2, agree: 1, judgePassedHumanFailed: 1 }]);
  });

  it('pairs hand labels with a rubric whose commit this clone lacks by the values its labels stored', async () => {
    const { config } = team();
    const elsewhere = { sourceHash: 'rubric-2', teamRevision: 'f'.repeat(40) };
    publishLabels(config, 'bob', [
      sessionLabel('one', { rubric: elsewhere, judge: { kind: 'human' }, label: 'missed-bug', score: 0, passed: false }),
      sessionLabel('two', { rubric: elsewhere, judge: { kind: 'human' } }),
      sessionLabel('one', { rubric: elsewhere, label: 'missed-bug', score: 0, passed: false }),
      sessionLabel('two', { rubric: elsewhere, label: 'missed-bug', score: 0, passed: false }),
    ]);
    const opened = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(opened.selected?.agreement.judges).toMatchObject([{ labels: 2, paired: 2, agree: 1, judgeFailedHumanPassed: 1 }]);
  });

  it.each([
    ['the scorer file there is another text, such as a rubric edited before its commit', (text: string, head: string) => ({ sourceHash: scorerSourceHash(`${text}Read the tests it ran.\n`), teamRevision: head })],
    ['the team revision is not a commit hash', (text: string) => ({ sourceHash: scorerSourceHash(text), teamRevision: 'HEAD' })],
  ])('pairs hand labels by the values the judge\'s labels stored when %s', async (_case, rubricAt) => {
    const { config } = team();
    const repo = config.repo.localPath;
    const text = '---\nlabels:\n  - { value: good, score: 1, description: Fixed it }\n  - { value: missed-bug, score: 0, description: Left the bug }\npassingScore: 1\n---\nJudge whether the session fixed the bug.\n';
    write(path.join(repo, 'scorers', 'review-quality.md'), text);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'scorer');
    const rubric = rubricAt(text, git(repo, 'rev-parse', 'HEAD'));
    publishLabels(config, 'bob', [
      sessionLabel('one', { rubric }),
      sessionLabel('two', { rubric }),
      sessionLabel('one', { judge: { kind: 'human' }, label: 'missed-bug', score: 0, passed: false }),
      sessionLabel('two', { judge: { kind: 'human' } }),
    ]);
    const opened = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    const cohort = opened.scorers[0]?.cohorts.find((one) => one.rubric.sourceHash === rubric.sourceHash);
    const view = await scorerResults({ config, query: { windowDays: 30, scorer: 'review-quality', cohort: cohort?.id }, now: NOW });
    expect(view.selected?.agreement.judges).toMatchObject([{ labels: 2, paired: 1, agree: 1 }]);
  });

  it('builds the reminder table from this machine\'s member sessions and contribute state only', async () => {
    const { config } = team();
    publishLabels(config, 'bob', [sessionLabel('fired'), sessionLabel('quiet', { passed: false }), sessionLabel('no-state'), sessionLabel('other-machine')]);
    write(path.join(root, 'home', '.teamai', 'sessions', 'fired.json'), JSON.stringify({ contributed: false, hinted: true }));
    write(path.join(root, 'home', '.teamai', 'sessions', 'quiet.json'), JSON.stringify({ contributed: false }));
    const start = (sessionId: string, extra: Partial<DashboardEvent> = {}): DashboardEvent => ({ type: 'session_start', timestamp: '2026-03-15T00:00:00.000Z', sessionId, tool: 'claude', ...extra });
    const events = [start('fired'), start('quiet'), start('no-state'), start('launched', { launchedBy: 'workflow' }), start('old', { timestamp: '2026-01-01T00:00:00.000Z' })];
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW, events });
    expect(view.selected?.reminders?.rows).toEqual([
      { reminder: 'yes', sessions: 1, labelled: 1, passed: 1, rate: 1 },
      { reminder: 'no', sessions: 1, labelled: 1, passed: 0, rate: 0 },
      { reminder: 'not recorded', sessions: 1, labelled: 1, passed: 1, rate: 1 },
    ]);
  });
});

describe('team reads between clicks', () => {
  it('counts labels a new reports commit adds, and this machine\'s own labels whenever they change', async () => {
    const { config } = team();
    const reports = getReportsDir(config);
    fs.mkdirSync(reports, { recursive: true });
    git(reports, 'init', '-q', '-b', 'teamai-reports');
    const commit = (labels: ScoreLabel[]) => {
      publishLabels(config, 'bob', labels);
      git(reports, 'add', '.');
      git(reports, 'commit', '-q', '-m', 'reports');
    };
    const n = async () => (await scorerResults({ config, query: { windowDays: 30 }, now: NOW })).selected?.cohort.stats.n;

    commit([sessionLabel('one')]);
    expect(await n()).toBe(1);
    commit([sessionLabel('one'), sessionLabel('two')]);
    expect(await n()).toBe(2);
    write(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), `${JSON.stringify(sessionLabel('mine'))}\n`);
    expect(await n()).toBe(3);
  });

  it('still answers from this machine\'s labels when the team clone is gone', async () => {
    const { config } = team();
    fs.rmSync(config.repo.localPath, { recursive: true, force: true });
    write(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), `${JSON.stringify(sessionLabel('mine'))}\n`);
    const view = await scorerResults({ config, query: { windowDays: 30 }, now: NOW });
    expect(view.selected?.cohort.stats.n).toBe(1);
  });
});

describe('reminder table over a long window', () => {
  it('covers only the 30 days this machine keeps reminder decisions for, and says so', async () => {
    const { config } = team();
    publishLabels(config, 'bob', [sessionLabel('recent'), sessionLabel('forgotten', { scoredAt: '2026-02-01T00:00:00.000Z' })]);
    write(path.join(root, 'home', '.teamai', 'sessions', 'recent.json'), JSON.stringify({ contributed: false, hinted: true }));
    const start = (sessionId: string, timestamp: string): DashboardEvent => ({ type: 'session_start', timestamp, sessionId, tool: 'claude' });
    const events = [start('recent', '2026-03-15T00:00:00.000Z'), start('forgotten', '2026-01-30T00:00:00.000Z')];
    const view = await scorerResults({ config, query: { windowDays: 90 }, now: NOW, events });
    expect(view.selected?.reminders).toEqual({
      days: 30,
      rows: [
        { reminder: 'yes', sessions: 1, labelled: 1, passed: 1, rate: 1 },
        { reminder: 'no', sessions: 0, labelled: 0, passed: 0, rate: null },
        { reminder: 'not recorded', sessions: 0, labelled: 0, passed: 0, rate: null },
      ],
    });
  });
});

describe('scorer query', () => {
  it('reads the window, scorer, cohort, grouping, commit and failing page, and refuses values the view does not offer', () => {
    const group = encodeURIComponent(JSON.stringify(['value', 'tdd', null, false]));
    expect(parseScorerQuery(new URLSearchParams(`window=90&scorer=review-quality&cohort=abc&groupBy=skill&commit=ABCDEF1&group=${group}&failing=75`))).toEqual({
      windowDays: 90, scorer: 'review-quality', cohort: 'abc', groupBy: 'skill', commit: 'abcdef1', failing: { group: JSON.stringify(['value', 'tdd', null, false]), limit: 75 },
    });
    expect(parseScorerQuery(new URLSearchParams(''))).toEqual({ windowDays: 30 });
    for (const bad of ['window=12', 'groupBy=prompt', 'commit=main;rm', 'failing=0', 'failing=10000', 'failing=2.5']) {
      expect(() => parseScorerQuery(new URLSearchParams(bad))).toThrow(HttpError);
    }
  });
});
