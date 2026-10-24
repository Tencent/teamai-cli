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

import { labelId, parseScoreLabels, type ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import type { LocalConfig } from '../types.js';

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

function modelLabel(scoredAt: string, label = 'good'): ScoreLabel {
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
});

describe('LabelStore', () => {
  it('publishes labels from two clones and keeps the newest per key on origin', async () => {
    const remote = origin();
    const first = clone(remote, 'first');
    const second = clone(remote, 'second');

    await LabelStore.append(first, modelLabel('2026-10-22T11:00:00.000Z', 'bad'), 'first look');
    expect(await LabelStore.publish(first)).toEqual({ state: 'published' });
    await LabelStore.append(second, modelLabel('2026-10-22T12:00:00.000Z', 'good'), 'second look');
    expect(await LabelStore.publish(second)).toEqual({ state: 'published' });
    // An older rescore from the first clone does not replace the newer label.
    await LabelStore.append(first, modelLabel('2026-10-22T11:30:00.000Z', 'bad'), 'stale');
    expect(await LabelStore.publish(first)).toEqual({ state: 'published' });

    const published = parseScoreLabels(git(remote, 'show', 'teamai-reports:scores/alice/2026-10.jsonl'));
    expect(published.map((label) => [label.label, label.scoredAt])).toEqual([['good', '2026-10-22T12:00:00.000Z']]);
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'teamai-reports')).not.toContain('reasoning');
    expect(fs.readdirSync(path.join(first.dataHome ?? '', 'scores', 'pending'))).toEqual([]);
  });

  it('keeps labels pending while usage reporting is off', async () => {
    const config = clone(origin(), 'off', { usageReportEnabled: false });
    await LabelStore.append(config, modelLabel('2026-10-22T11:00:00.000Z'), 'kept');
    expect(await LabelStore.publish(config)).toEqual({ state: 'pending', reason: 'Usage reporting is off, so labels stay on this machine.' });
    expect(fs.readdirSync(path.join(config.dataHome ?? '', 'scores', 'pending'))).toHaveLength(1);
  });

  it('keeps labels here and says why when the team repo is http, which has no teamai-reports branch', async () => {
    const config = clone(origin(), 'http');
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    await LabelStore.append(http, modelLabel('2026-10-22T11:00:00.000Z'), 'kept');

    expect(await LabelStore.publish(http)).toEqual({
      state: 'unsupported',
      reason: 'Publishing score labels needs a team repo with a teamai-reports branch; an http team repo has none, so labels stay on this machine.',
    });
    expect(fs.readdirSync(path.join(http.dataHome ?? '', 'scores', 'pending'))).toHaveLength(1);
  });

  it('counts the labels a push would publish: pending ones, and none while usage reporting is off', async () => {
    const config = clone(origin(), 'count');
    await LabelStore.append(config, modelLabel('2026-10-22T11:00:00.000Z'), 'kept');

    expect(await LabelStore.unpublished(config)).toBe(1);
    expect(await LabelStore.unpublished({ ...config, usageReportEnabled: false })).toBe(0);
    await LabelStore.publish(config);
    expect(await LabelStore.unpublished(config)).toBe(0);
  });

  it('keeps a label scored again during a push pending, and publishes it with the next push', async () => {
    const remote = origin();
    const config = clone(remote, 'rescored');
    const rescore = modelLabel('2026-10-22T12:00:00.000Z', 'bad');
    await LabelStore.append(config, modelLabel('2026-10-22T11:00:00.000Z'), 'first');
    during.push = async () => { await LabelStore.append(config, rescore, 'second'); };

    expect(await LabelStore.publish(config)).toEqual({ state: 'pending', reason: 'a label was scored again while the others were published' });
    expect(fs.readdirSync(path.join(config.dataHome ?? '', 'scores', 'pending'))).toEqual([`${labelId(rescore)}.json`]);
    during.push = async () => {};
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(parseScoreLabels(git(remote, 'show', 'teamai-reports:scores/alice/2026-10.jsonl'))).toEqual([rescore]);
  });

  it('keeps a label only once its outbox entry is written, so a failed write never strands it unpublished', async () => {
    const config = clone(origin(), 'crash');
    const scores = path.join(config.dataHome ?? '', 'scores');
    const label = modelLabel('2026-10-22T11:00:00.000Z');
    fs.mkdirSync(scores, { recursive: true });
    fs.writeFileSync(path.join(scores, 'pending'), 'in the way');
    await expect(LabelStore.append(config, label, 'lost')).rejects.toThrow();
    fs.rmSync(path.join(scores, 'pending'));
    expect(await LabelStore.local(config)).toEqual([]);

    fs.mkdirSync(path.join(scores, 'labels.jsonl'));
    await expect(LabelStore.append(config, label, 'kept')).rejects.toThrow();
    fs.rmdirSync(path.join(scores, 'labels.jsonl'));
    expect(await LabelStore.local(config)).toEqual([label]);
    expect(fs.readdirSync(path.join(scores, 'pending'))).toEqual([`${labelId(label)}.json`]);
    expect(await LabelStore.publish(config)).toEqual({ state: 'published' });
    expect(await LabelStore.local(config)).toEqual([label]);
  });

  it('shows one label per pass and scorer, a hand label over a model label', async () => {
    const config = clone(origin(), 'shown');
    await LabelStore.append(config, modelLabel('2026-10-22T11:00:00.000Z', 'bad'), 'model');
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'bad', passed: false }]);
    await LabelStore.append(config, { ...modelLabel('2026-10-22T10:00:00.000Z', 'good'), judge: { kind: 'human' } }, 'person');
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'good', passed: true }]);
  });

  it('shows the newest model label of a scorer across its rubric versions', async () => {
    const config = clone(origin(), 'rescored');
    await LabelStore.append(config, modelLabel('2026-10-22T10:00:00.000Z', 'good'), 'old rubric');
    await LabelStore.append(config, { ...modelLabel('2026-10-22T11:00:00.000Z', 'bad'), rubric: { sourceHash: 'h2' } }, 'new rubric');
    expect((await LabelStore.ofRuns(config, [runSubject.runId], { published: false })).get(runSubject.runId)?.get('review#1'))
      .toEqual([{ scorer: 'quality', label: 'bad', passed: false }]);
  });
});
