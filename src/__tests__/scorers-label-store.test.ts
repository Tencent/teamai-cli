import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const during = vi.hoisted(() => ({ push: async (): Promise<void> => {} }));
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  return { ...actual, updateReports: async (...args: Parameters<typeof actual.updateReports>) => {
    await during.push();
    return actual.updateReports(...args);
  } };
});

import { labelId, newestLabels, parseScoreLabels, type ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import type { LocalConfig } from '../types.js';
import { whileLabelsLocked } from './helpers/label-lock.js';

let tmp = '';
let home = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-label-store-'));
  home = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  during.push = async () => {};
  process.env.HOME = home;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function origin(): string {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(tmp, 'clone', '-q', '--bare', seed, 'origin.git');
  return path.join(tmp, 'origin.git');
}

/** A clone in a directory of its own: the reports checkout of a git clone is its sibling. */
function clone(remote: string, name: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
  git(root, 'clone', '-q', remote, 'repo');
  git(path.join(root, 'repo'), 'config', 'user.name', 'E2E');
  git(path.join(root, 'repo'), 'config', 'user.email', 'e2e@example.invalid');
  return {
    repo: { localPath: path.join(root, 'repo'), remote, kind: 'git' },
    username: 'alice', scope: 'user', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'), ...overrides,
  };
}

const runSubject = { runId: 'r0123456789abcdef', step: 'review', pass: 1 };

function modelLabel(scoredAt: string, label = 'good'): Extract<ScoreLabel, { source: 'workflow' }> {
  return {
    scorer: 'quality', rubric: { sourceHash: 'h1' }, label, score: label === 'good' ? 1 : 0, passed: label === 'good',
    source: 'workflow', subject: runSubject,
    judge: { kind: 'model', tool: 'claude', usage: { inputTokens: 5, outputTokens: 1, cost: { amount: 0.01, unit: 'USD' } }, isolation: 'verified', access: 'read' },
    scoredAt,
  };
}

describe('ScoreLabel', () => {
  it('reads a workflow label and a hand-written session label with one parser, and keys them by judge kind', () => {
    const session = '{"scorer":"quality","rubric":{"sourceHash":"h1"},"label":"good","score":1,"passed":true,"source":"session","subject":{"platform":"claude-code","sessionId":"7c1e"},"judge":{"kind":"human"},"scoredAt":"2026-10-22T10:00:00.000Z"}';
    const workflow = JSON.stringify(modelLabel('2026-10-22T11:00:00.000Z'));
    const parsed = parseScoreLabels(`${session}\n${workflow}\n{"broken":\n`);
    expect(parsed.map((label) => [label.source, label.judge.kind])).toEqual([['session', 'human'], ['workflow', 'model']]);
    const hand: ScoreLabel = { ...modelLabel('2026-10-22T12:00:00.000Z'), judge: { kind: 'human' } };
    expect(labelId(hand)).not.toBe(labelId(modelLabel('2026-10-22T11:00:00.000Z')));
    expect(labelId(modelLabel('2026-10-22T12:00:00.000Z', 'bad'))).toBe(labelId(modelLabel('2026-10-22T11:00:00.000Z')));
    expect(parseScoreLabels('{"scorer":"q","rubric":{"sourceHash":"h"},"label":"x","score":1,"passed":true,"source":"workflow","subject":{"platform":"p","sessionId":"s"},"judge":{"kind":"human"},"scoredAt":"2026-10-22T10:00:00.000Z"}')).toEqual([]);
  });

  it('reads back the agent a workflow label judged, and keys the label as it was keyed before labels carried one', () => {
    const agent = {
      v: 1 as const, tool: { name: 'claude' }, model: { requested: 'claude-review-1' }, teamai: '1.0.0', driver: 'local',
      team: { revision: 'a'.repeat(40), localChanges: false, selection: { scope: 'project' as const, primaryRole: 'frontend', additionalRoles: [], stepRole: 'review' } },
    };
    const label: ScoreLabel = { ...modelLabel('2026-10-22T11:00:00.000Z'), judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }, agent };

    expect(parseScoreLabels(JSON.stringify(label))).toEqual([label]);
    // The key of this label without `agent`, as the release before labels carried one computed it.
    const { agent: _agent, ...before } = label;
    expect(labelId(label)).toBe(labelId(before));
  });

  it('keeps one label per model judge: another tool or model sits beside the first, and the same judge replaces it', () => {
    const claude = modelLabel('2026-10-22T11:00:00.000Z', 'bad');
    const codex: ScoreLabel = { ...modelLabel('2026-10-22T12:00:00.000Z'), judge: { kind: 'model', tool: 'codex', isolation: 'verified', access: 'read' } };
    const strongerClaude: ScoreLabel = { ...modelLabel('2026-10-22T12:30:00.000Z'), judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-opus-5-5' }, isolation: 'verified', access: 'read' } };
    const claudeAgain = modelLabel('2026-10-22T13:00:00.000Z', 'good');
    const hand: ScoreLabel = { ...modelLabel('2026-10-22T09:00:00.000Z'), judge: { kind: 'human' } };
    expect(newestLabels([claude, codex, strongerClaude, claudeAgain, hand]).map((label) => [label.judge.kind === 'model' ? label.judge.tool : 'human', label.scoredAt]))
      .toEqual([['claude', '2026-10-22T13:00:00.000Z'], ['codex', '2026-10-22T12:00:00.000Z'], ['claude', '2026-10-22T12:30:00.000Z'], ['human', '2026-10-22T09:00:00.000Z']]);
    expect(labelId(codex)).not.toBe(labelId(claude));
    expect(labelId(claudeAgain)).toBe(labelId(claude));
  });
});

describe('a label a stage decided', () => {
  const stage = (scoredAt: string, decidedBy: string | undefined, fields: Record<string, unknown> = {}) => JSON.stringify({ ...modelLabel(scoredAt, 'bad'), judge: { kind: 'stage' }, ...decidedBy ? { decidedBy } : {}, ...fields });
  /** A label a stage decided as v0.29.0 wrote it: the judge the lease would have run. */
  const before: ScoreLabel = { ...modelLabel('2026-10-22T10:00:00.000Z', 'bad'), decidedBy: 'ci' };

  it('reads judge kind stage only with the check, CI or protected stage that decided it', () => {
    expect(parseScoreLabels(stage('2026-10-22T11:00:00.000Z', 'ci')).map((label) => label.judge)).toEqual([{ kind: 'stage' }]);
    expect(parseScoreLabels([stage('2026-10-22T11:00:00.000Z', 'judge'), stage('2026-10-22T11:00:00.000Z', undefined)].join('\n'))).toEqual([]);
    expect(parseScoreLabels(stage('2026-10-22T11:00:00.000Z', undefined, { source: 'session', subject: { platform: 'claude-code', sessionId: '7c1e' } }))).toEqual([]);
    expect(parseScoreLabels(JSON.stringify(before))).toEqual([before]);
  });

  it('keys a stage decision as a stage whichever shape wrote it, so the newer replaces the older', () => {
    const [after] = parseScoreLabels(stage('2026-10-22T11:00:00.000Z', 'ci'));

    expect(after && labelId(after)).toBe(labelId(before));
    expect(newestLabels([before, ...after ? [after] : []])).toEqual([after]);
    expect(labelId(modelLabel('2026-10-22T09:00:00.000Z'))).not.toBe(labelId(before));
  });
});

describe('LabelStore', () => {
  it('writes no label of a batch while another teamai process holds the label store lock, and the whole batch once it is free', async () => {
    const config = clone(origin(), 'writers');
    const batch = [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'first' }, { label: { ...modelLabel('2026-10-22T11:00:00.000Z', 'bad'), scorer: 'tests' }, reasoning: 'second' }];

    expect(await whileLabelsLocked(config, () => LabelStore.append(config, batch))).toEqual({ status: 'busy' });
    expect(await LabelStore.local(config)).toEqual([]);

    expect(await LabelStore.append(config, batch)).toMatchObject({ status: 'done', kept: [{ id: labelId(batch[0].label) }, { id: labelId(batch[1].label) }] });
    expect(await LabelStore.local(config)).toEqual(batch.map(({ label }) => label));
  });

  it('keeps both batches of two writers at once, each label one whole line, while the second waits for the first', async () => {
    const config = clone(origin(), 'together');
    const of = (scorer: string, at: string) => [{ label: { ...modelLabel(at), scorer }, reasoning: scorer }, { label: { ...modelLabel(at, 'bad'), scorer: `${scorer}-strict` }, reasoning: scorer }];

    const written = await Promise.all([LabelStore.append(config, of('quality', '2026-10-22T11:00:00.000Z')), LabelStore.append(config, of('tests', '2026-10-22T11:00:01.000Z'))]);

    expect(written.map(({ status }) => status)).toEqual(['done', 'done']);
    const lines = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trimEnd().split('\n');
    expect(parseScoreLabels(lines.join('\n')).map(({ scorer }) => scorer).sort()).toEqual(['quality', 'quality-strict', 'tests', 'tests-strict']);
    expect(lines).toHaveLength(4);
    expect(fs.readdirSync(path.join(config.dataHome ?? '', 'scores', 'pending'))).toHaveLength(4);
  });

  it('publishes labels from two clones and keeps the newest per key on origin', async () => {
    const remote = origin();
    const first = clone(remote, 'first');
    const second = clone(remote, 'second');

    await LabelStore.append(first, [{ label: modelLabel('2026-10-22T11:00:00.000Z', 'bad'), reasoning: 'first look' }]);
    expect(await LabelStore.publish(first)).toEqual({ state: 'published' });
    await LabelStore.append(second, [{ label: modelLabel('2026-10-22T12:00:00.000Z', 'good'), reasoning: 'second look' }]);
    expect(await LabelStore.publish(second)).toEqual({ state: 'published' });
    // An older rescore from the first clone does not replace the newer label.
    await LabelStore.append(first, [{ label: modelLabel('2026-10-22T11:30:00.000Z', 'bad'), reasoning: 'stale' }]);
    expect(await LabelStore.publish(first)).toEqual({ state: 'published' });

    const published = parseScoreLabels(git(remote, 'show', 'teamai-reports:scores/alice/2026-10.jsonl'));
    expect(published.map((label) => [label.label, label.scoredAt])).toEqual([['good', '2026-10-22T12:00:00.000Z']]);
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'teamai-reports')).not.toContain('reasoning');
    expect(fs.readdirSync(path.join(first.dataHome ?? '', 'scores', 'pending'))).toEqual([]);
  });

  it('publishes and clears a label an older teamai left in the outbox under the file name of its older key', async () => {
    const remote = origin();
    const config = clone(remote, 'upgraded');
    const upgraded = modelLabel('2026-10-22T11:00:00.000Z', 'bad');
    await LabelStore.append(config, [{ label: upgraded, reasoning: 'scored before the upgrade' }]);
    const id = labelId(upgraded);
    const pending = path.join(config.dataHome ?? '', 'scores', 'pending');
    fs.renameSync(path.join(pending, `${id}.json`), path.join(pending, `${'0'.repeat(64)}.json`));

    expect(await LabelStore.local(config)).toMatchObject([{ label: 'bad' }]);
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(parseScoreLabels(git(remote, 'show', 'teamai-reports:scores/alice/2026-10.jsonl')).map((label) => label.label)).toEqual(['bad']);
    expect(fs.readdirSync(pending)).toEqual([]);
  });

  it('keeps labels pending while usage reporting is off', async () => {
    const config = clone(origin(), 'off', { usageReportEnabled: false });
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'kept' }]);
    expect(await LabelStore.publish(config)).toEqual({ state: 'pending', reason: 'Usage reporting is off, so labels stay on this machine.' });
    expect(fs.readdirSync(path.join(config.dataHome ?? '', 'scores', 'pending'))).toHaveLength(1);
  });

  it('keeps labels here and says why when the team repo is http, which has no teamai-reports branch', async () => {
    const config = clone(origin(), 'http');
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    await LabelStore.append(http, [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'kept' }]);

    expect(await LabelStore.publish(http)).toEqual({
      state: 'unsupported',
      reason: 'Publishing score labels needs a team repo with a teamai-reports branch; an http team repo has none, so labels stay on this machine.',
    });
    expect(fs.readdirSync(path.join(http.dataHome ?? '', 'scores', 'pending'))).toHaveLength(1);
  });

  it('counts the labels a push would publish: pending ones, and none while usage reporting is off', async () => {
    const config = clone(origin(), 'count');
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'kept' }]);

    expect(await LabelStore.unpublished(config)).toBe(1);
    expect(await LabelStore.unpublished({ ...config, usageReportEnabled: false })).toBe(0);
    await LabelStore.publish(config);
    expect(await LabelStore.unpublished(config)).toBe(0);
  });

  it('keeps a label scored again during a push pending, and publishes it with the next push', async () => {
    const remote = origin();
    const config = clone(remote, 'rescored');
    const rescore = modelLabel('2026-10-22T12:00:00.000Z', 'bad');
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'first' }]);
    during.push = async () => { await LabelStore.append(config, [{ label: rescore, reasoning: 'second' }]); };

    expect(await LabelStore.publish(config)).toEqual({ state: 'pending', reason: 'a label was scored again while the others were published' });
    expect(fs.readdirSync(path.join(config.dataHome ?? '', 'scores', 'pending'))).toEqual([`${labelId(rescore)}.json`]);
    during.push = async () => {};
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(parseScoreLabels(git(remote, 'show', 'teamai-reports:scores/alice/2026-10.jsonl'))).toEqual([rescore]);
  });

  it('clears the outbox only under the label store lock, and leaves it for the next push while a label is being written', async () => {
    const config = clone(origin(), 'locked');
    const pending = path.join(config.dataHome ?? '', 'scores', 'pending');
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z'), reasoning: 'first' }]);

    expect(await whileLabelsLocked(config, () => LabelStore.publish(config))).toEqual({ state: 'pending', reason: 'another teamai process is writing a score label' });
    expect(fs.readdirSync(pending)).toHaveLength(1);
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(fs.readdirSync(pending)).toEqual([]);
  });

  it('keeps a label only once its outbox entry is written, so a failed write never strands it unpublished', async () => {
    const config = clone(origin(), 'crash');
    const scores = path.join(config.dataHome ?? '', 'scores');
    const label = modelLabel('2026-10-22T11:00:00.000Z');
    fs.mkdirSync(scores, { recursive: true });
    fs.writeFileSync(path.join(scores, 'pending'), 'in the way');
    await expect(LabelStore.append(config, [{ label, reasoning: 'lost' }])).rejects.toThrow();
    fs.rmSync(path.join(scores, 'pending'));
    expect(await LabelStore.local(config)).toEqual([]);

    fs.mkdirSync(path.join(scores, 'labels.jsonl'));
    await expect(LabelStore.append(config, [{ label, reasoning: 'kept' }])).rejects.toThrow();
    fs.rmdirSync(path.join(scores, 'labels.jsonl'));
    expect(await LabelStore.local(config)).toEqual([label]);
    expect(fs.readdirSync(path.join(scores, 'pending'))).toEqual([`${labelId(label)}.json`]);
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(await LabelStore.local(config)).toEqual([label]);
  });

  it('shows one label per pass and scorer, a hand label over a model label', async () => {
    const config = clone(origin(), 'shown');
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z', 'bad'), reasoning: 'model' }]);
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'bad', score: 0, passed: false }]);
    await LabelStore.append(config, [{ label: { ...modelLabel('2026-10-22T10:00:00.000Z', 'good'), judge: { kind: 'human' } }, reasoning: 'person' }]);
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'good', score: 1, passed: true, decidedBy: 'hand' }]);
  });

  it('shows the newer of a label a stage decided and a model label of a scorer', async () => {
    const config = clone(origin(), 'staged');
    const shown = async () => (await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1');
    await LabelStore.append(config, [{ label: { ...modelLabel('2026-10-22T10:00:00.000Z', 'bad'), judge: { kind: 'stage' }, decidedBy: 'ci' }, reasoning: 'ci failed' }]);
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T11:00:00.000Z', 'good'), reasoning: 'judged' }]);

    expect(await shown()).toEqual([{ scorer: 'quality', label: 'good', score: 1, passed: true }]);
    await LabelStore.append(config, [{ label: { ...modelLabel('2026-10-22T12:00:00.000Z', 'bad'), judge: { kind: 'stage' }, decidedBy: 'check' }, reasoning: 'check failed' }]);
    expect(await shown()).toEqual([{ scorer: 'quality', label: 'bad', score: 0, passed: false, decidedBy: 'check' }]);
  });

  it('shows the newest model label of a scorer across its rubric versions', async () => {
    const config = clone(origin(), 'rescored');
    await LabelStore.append(config, [{ label: modelLabel('2026-10-22T10:00:00.000Z', 'good'), reasoning: 'old rubric' }]);
    await LabelStore.append(config, [{ label: { ...modelLabel('2026-10-22T11:00:00.000Z', 'bad'), rubric: { sourceHash: 'h2' } }, reasoning: 'new rubric' }]);
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'bad', score: 0, passed: false }]);
  });
});
