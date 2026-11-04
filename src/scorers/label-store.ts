/**
 * The label store every scorer source writes to. On this machine: `<dataHome>/scores/labels.jsonl`, one label per line,
 * the judge's reasoning in `reasoning/<labelVersion>.md`, and an outbox `pending/<labelId>.json`. Published:
 * `scores/<member>/<YYYY-MM>.jsonl` on teamai-reports. Readers keep the newest `scoredAt` per key. Reasoning never leaves
 * this machine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import { getReportsDir, isUsageReportEnabled, usesBranchWorktree, type LocalConfig } from '../types.js';
import { readFileSafe, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { scoresDir, scoresLocked } from './home.js';
import { isStageDecider, labelId, type Decider, labelVersion, newestLabels, parseScoreLabel, parseScoreLabels, type ScoreLabel } from './label.js';
import type { ConfinedUsage } from '../tool-launch/confined-level.js';

function labelsFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'labels.jsonl');
}

function pendingDir(config: LocalConfig): string {
  return path.join(scoresDir(config), 'pending');
}

export function reasoningPath(config: LocalConfig, id: string): string {
  return path.join(scoresDir(config), 'reasoning', `${id}.md`);
}

/**
 * What a member can do with a label that did not pass: turn its reasoning into a learning for the team, marking the
 * scored session as contributed when there is one.
 */
export function shareFailedLabelHint(reasoningFile: string, sessionId?: string): string {
  return `To share what went wrong, ask your agent to read ${reasoningFile} and share it with the team (teamai contribute${sessionId ? ` --session-id ${sessionId}` : ''}).`;
}

/** Where a label is published: the member's file for the UTC month it was scored in. */
function publishedPath(username: string, label: ScoreLabel): string {
  return `scores/${username}/${label.scoredAt.slice(0, 7)}.jsonl`;
}

function reasoningText(label: ScoreLabel, reasoning: string, prompt: string | undefined): string {
  return [
    `scorer: ${label.scorer}`,
    `rubric.sourceHash: ${label.rubric.sourceHash}`,
    `subject: ${JSON.stringify(label.subject)}`,
    `label: ${label.label}`,
    `scoredAt: ${label.scoredAt}`,
    ...(prompt === undefined ? [] : [`prompt: ${prompt}`]),
    '',
    reasoning,
    '',
  ].join('\n');
}

async function readPending(config: LocalConfig): Promise<Array<{ id: string; label: ScoreLabel }>> {
  const files = (await fs.readdir(pendingDir(config)).catch(() => [])).filter((file) => file.endsWith('.json')).sort();

  const read = await Promise.all(files.map(async (file) => {
    try {
      const label = parseScoreLabel(JSON.parse(await readFileSafe(path.join(pendingDir(config), file)) ?? 'null'));

      return label ? [{ id: file.slice(0, -'.json'.length), label }] : [];
    } catch {
      return [];
    }
  }));

  return read.flat();
}

/** Every label on the reports checkout as it is, with the member whose `scores/<member>/` file holds it. */
async function publishedByMember(config: LocalConfig): Promise<Array<{ member: string; label: ScoreLabel }>> {
  const root = path.join(getReportsDir(config), 'scores');
  const members = await fs.readdir(root).catch(() => []);

  const files = (await Promise.all(members.map(async (member) => (await fs.readdir(path.join(root, member)).catch(() => []))
    .filter((file) => file.endsWith('.jsonl')).map((file) => ({ member, file: path.join(root, member, file) }))))).flat();

  return (await Promise.all(files.map(async ({ member, file }) => parseScoreLabels(await readFileSafe(file) ?? '').map((label) => ({ member, label }))))).flat();
}

async function publishedLabels(config: LocalConfig): Promise<ScoreLabel[]> {
  return (await publishedByMember(config)).map(({ label }) => label);
}

/** Whether a publish delivered every pending label, and when not, why they stay on this machine. */
/** Where `publish` left the labels. `unsupported`: the team repo has no teamai-reports branch, so they stay pending here. */
export type LabelDelivery = { state: 'published' } | { state: 'pending' | 'unsupported'; reason: string };

/**
 * What Workflow Runs shows of a label: never its reasoning, judge, or usage. `decidedBy` is `hand` for a hand label, and
 * absent on a model label from before #1247, which a judge decided.
 */
export type PassScore = Pick<ScoreLabel, 'scorer' | 'label' | 'score' | 'passed'> & { decidedBy?: Decider | 'hand' };

type RunLabel = Extract<ScoreLabel, { source: 'workflow' }>;

/** What judging a run cost, kept apart from the run's own tokens. */
export interface ScoringTotal {
  judged: number;
  inputTokens: number;
  outputTokens: number;
}

/** A label as Workflow Runs shows it; `decidedBy` only when it is a hand label or the label recorded it. */
function passScoreOf(label: RunLabel): PassScore {
  const score: PassScore = { scorer: label.scorer, label: label.label, score: label.score, passed: label.passed };
  const decidedBy = label.judge.kind === 'human' ? 'hand' : label.decidedBy;

  if (decidedBy) score.decidedBy = decidedBy;

  return score;
}

/**
 * Runs `change` under `scores/labels.lock`, which `publish` takes to clear the outbox, so a label `change` appends is
 * never cleared unpublished.
 */
async function locked<T>(config: LocalConfig, change: () => Promise<T>): Promise<{ status: 'done'; value: T } | { status: 'busy' }> {
  return scoresLocked(config, 'labels', change);
}

/** One label `LabelStore.append` keeps, with a model judge's reasoning and the redacted prompt that heads its file. */
export interface KeptLabel {
  label: ScoreLabel;
  reasoning?: string;
  prompt?: string;
}

/**
 * The outbox entry commits the label: a failure before it records no label, and one after it leaves a label that
 * `local` reads and `publish` still sends. Only `LabelStore.append` calls it, under the label store lock.
 */
async function appendOne(config: LocalConfig, { label, reasoning, prompt }: KeptLabel, outbox: boolean): Promise<{ id: string; version: string }> {
  const id = labelId(label);
  const version = labelVersion(label);

  if (reasoning !== undefined) await writeFileAtomic(reasoningPath(config, version), reasoningText(label, reasoning, prompt));

  if (outbox) await writeJsonAtomic(path.join(pendingDir(config), `${id}.json`), label);
  await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');

  return { id, version };
}

/**
 * Takes the labels of `sent` out of the outbox, each while its pending file still holds that label, so a rescore written
 * meanwhile stays pending, and appends one an interrupted `append` left out of `labels.jsonl`.
 */
async function clearSent(config: LocalConfig, sent: ReadonlyArray<{ id: string; label: ScoreLabel }>): Promise<'cleared' | 'busy'> {
  if (sent.length === 0) return 'cleared';

  const cleared = await locked(config, async () => {
    const appended = new Set(parseScoreLabels(await readFileSafe(labelsFile(config)) ?? '').map(labelVersion));

    for (const { id, label } of sent) {
      const file = path.join(pendingDir(config), `${id}.json`);
      const current = parseScoreLabel(JSON.parse(await readFileSafe(file) ?? 'null'));

      if (current?.scoredAt !== label.scoredAt) continue;

      if (!appended.has(labelVersion(label))) await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
      await fs.rm(file, { force: true });
    }
  });

  return cleared.status === 'busy' ? 'busy' : 'cleared';
}

/** Whether `labels` hold `label`, or a newer label of its key. */
function holds(labels: readonly ScoreLabel[], label: ScoreLabel): boolean {
  return labels.some((other) => labelId(other) === labelId(label) && other.scoredAt >= label.scoredAt);
}

function addUsage(total: { inputTokens: number; outputTokens: number }, usage: ConfinedUsage | undefined): void {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
}

export const LabelStore = {
  /**
   * Keeps every label of `labels` under `scores/labels.lock`, which `publish` takes to clear the outbox, or none while
   * another process holds it (`busy`). Answers each of `labels` with the label's `id` and the `version` that names its
   * reasoning file, in order. A hand label has no `reasoning`, and no reasoning file. With `outbox: false` the labels stay on this machine,
   * as those of a private or isolated run do, and no publish sends them. An empty batch takes no lock.
   */
  async append<TLabel extends KeptLabel>(config: LocalConfig, labels: readonly TLabel[], { outbox = true }: { outbox?: boolean } = {}): Promise<{ status: 'done'; kept: Array<TLabel & { id: string; version: string }> } | { status: 'busy' }> {
    if (labels.length === 0) return { status: 'done', kept: [] };

    const written = await locked(config, async () => {
      const kept: Array<TLabel & { id: string; version: string }> = [];

      for (const one of labels) kept.push({ ...one, ...await appendOne(config, one, outbox) });

      return kept;
    });

    return written.status === 'busy' ? written : { status: 'done', kept: written.value };
  },

  /** The labels on the reports checkout as it is, every version of each, with the member who published it. */
  published: publishedByMember,

  /** This machine's labels, appended or still pending, the newest per key. */
  async local(config: LocalConfig): Promise<ScoreLabel[]> {
    const pending = (await readPending(config)).map(({ label }) => label);

    return newestLabels([...parseScoreLabels(await readFileSafe(labelsFile(config)) ?? ''), ...pending]);
  },

  /**
   * Publishes every pending label to `scores/<member>/<YYYY-MM>.jsonl`, merged by key against what origin holds, so an
   * older label from another clone never replaces a newer one. A pending file is removed only while it still holds the
   * label that was sent, so a rescore written during the push stays pending. A label an interrupted `append` left out of
   * `labels.jsonl` is appended there first. Nothing is published with usage reporting off.
   */
  async publish(config: LocalConfig): Promise<LabelDelivery> {
    if (!usesBranchWorktree(config)) {
      return { state: 'unsupported', reason: 'Publishing score labels needs a team repo with a teamai-reports branch; an http team repo has none, so labels stay on this machine.' };
    }

    const pending = await readPending(config);

    if (pending.length === 0) return { state: 'published' };

    if (!isUsageReportEnabled(config, (await loadTeamConfig(config.repo.localPath)) ?? {})) {
      return { state: 'pending', reason: 'Usage reporting is off, so labels stay on this machine.' };
    }

    const username = config.username ?? 'unknown';
    const { updateReports, readReportsOriginFile } = await import('../utils/reports-branch.js');

    const outcome = await updateReports(config, async (worktree) => {
      const byFile = new Map<string, ScoreLabel[]>();

      for (const { label } of pending) byFile.set(publishedPath(username, label), [...byFile.get(publishedPath(username, label)) ?? [], label]);

      for (const [file, labels] of byFile) {
        const origin = parseScoreLabels(await readReportsOriginFile(worktree, file) ?? '');
        const merged = newestLabels([...origin, ...labels]);
        await fs.mkdir(path.join(worktree, path.dirname(file)), { recursive: true });
        await fs.writeFile(path.join(worktree, file), merged.map((label) => `${JSON.stringify(label)}\n`).join(''), 'utf8');
      }

      return { files: [...byFile.keys()], message: `[teamai] Publish ${pending.length} score label${pending.length === 1 ? '' : 's'}` };
    });

    switch (outcome.status) {
      case 'published':
      case 'already-present': {
        if (await clearSent(config, pending) === 'busy') return { state: 'pending', reason: 'another teamai process is writing a score label' };

        return (await readPending(config)).length === 0
          ? { state: 'published' }
          : { state: 'pending', reason: 'a label was scored again while the others were published' };
      }

      case 'busy':
        return { state: 'pending', reason: 'another teamai process is writing teamai-reports' };
      case 'failed':
        return { state: 'pending', reason: outcome.reason };
      default: {
        const unhandled: never = outcome;

        return unhandled;
      }
    }
  },

  /**
   * Writes this machine's pending labels into `dir`, a checkout of teamai-reports at origin's tip, each into
   * `scores/<member>/<YYYY-MM>.jsonl` merged by key with what that file holds, and answers the files it wrote and how
   * many labels. A pending label the file already holds, or holds a newer label of its key, leaves the outbox instead.
   * Writes nothing with usage reporting off, or for an http team repo, and says why.
   */
  async stage(config: LocalConfig, dir: string): Promise<{ files: string[]; labels: number; reason?: string }> {
    if (!usesBranchWorktree(config)) return { files: [], labels: 0, reason: 'An http team repo has no teamai-reports branch, so labels stay on this machine.' };
    const pending = await readPending(config);

    if (pending.length === 0) return { files: [], labels: 0 };

    if (!isUsageReportEnabled(config, (await loadTeamConfig(config.repo.localPath)) ?? {})) return { files: [], labels: 0, reason: 'Usage reporting is off, so labels stay on this machine.' };
    const username = config.username ?? 'unknown';
    const byFile = new Map<string, Array<{ id: string; label: ScoreLabel }>>();

    for (const entry of pending) byFile.set(publishedPath(username, entry.label), [...byFile.get(publishedPath(username, entry.label)) ?? [], entry]);
    const delivered: Array<{ id: string; label: ScoreLabel }> = [];
    const files: string[] = [];
    let labels = 0;

    for (const [file, entries] of byFile) {
      const tip = parseScoreLabels(await readFileSafe(path.join(dir, file)) ?? '');
      const sending = entries.filter((entry) => !holds(tip, entry.label));
      delivered.push(...entries.filter((entry) => holds(tip, entry.label)));

      if (sending.length === 0) continue;
      await fs.mkdir(path.join(dir, path.dirname(file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), newestLabels([...tip, ...sending.map(({ label }) => label)]).map((label) => `${JSON.stringify(label)}\n`).join(''), 'utf8');
      files.push(file);
      labels += sending.length;
    }

    await clearSent(config, delivered);

    return { files, labels };
  },

  /** How many labels a push would publish: the pending ones, or none while usage reporting is off. */
  async unpublished(config: LocalConfig): Promise<number> {
    if (!isUsageReportEnabled(config, (await loadTeamConfig(config.repo.localPath)) ?? {})) return 0;

    return (await readPending(config)).length;
  },

  /** `publish`, telling the member where the labels are: `teamai score --push`'s answer. */
  async push(config: LocalConfig): Promise<{ data: { published: boolean } } | { error: { code: string; message: string } }> {
    const delivery = await LabelStore.publish(config);

    if (delivery.state === 'unsupported') return { error: { code: 'unsupported_repo', message: delivery.reason } };

    if (delivery.state === 'published') {
      log.info('Every score label of this machine is on teamai-reports.');

      return { data: { published: true } };
    }

    log.warn(delivery.reason);
    log.info('The labels stay pending until teamai score --push can publish them.');

    return { data: { published: false } };
  },

  /**
   * The labels of workflow runs `runIds` by run and `${step}#${pass}`, from this machine and, with `published`, from the
   * reports checkout as it is. Per pass and scorer, a hand label beats a model or stage label, and of those the newest
   * across rubric versions is shown.
   */
  async ofRuns(config: LocalConfig, runIds: readonly string[], options: { published: boolean }): Promise<Map<string, Map<string, PassScore[]>>> {
    const wanted = new Set(runIds);

    const labels = newestLabels([
      ...await LabelStore.local(config),
      ...options.published ? await publishedLabels(config) : [],
    ]);

    const isHand = (label: ScoreLabel) => label.judge.kind === 'human';
    const outranks = (label: ScoreLabel, other: ScoreLabel): boolean => (isHand(label) === isHand(other) ? label.scoredAt > other.scoredAt : isHand(label));

    const byRun = new Map<string, Map<string, RunLabel[]>>();

    for (const label of labels) {
      if (label.source !== 'workflow' || !wanted.has(label.subject.runId)) continue;
      const passes = byRun.get(label.subject.runId) ?? new Map<string, RunLabel[]>();
      byRun.set(label.subject.runId, passes);
      const key = `${label.subject.step}#${label.subject.pass}`;
      const shown = passes.get(key) ?? [];
      const index = shown.findIndex((other) => other.scorer === label.scorer);
      const current = shown[index];

      if (!current) shown.push(label);
      else if (outranks(label, current)) shown[index] = label;
      passes.set(key, shown);
    }

    return new Map([...byRun].map(([run, passes]) => [run, new Map([...passes].map(([key, shown]) => [
      key, shown.map(passScoreOf),
    ]))]));
  },

  /** What the judge labels of run `runId` cost, from this machine's labels or the published ones; a stage decision is no judge call. */
  async scoringTotal(config: LocalConfig, runId: string, source: 'local' | 'published'): Promise<ScoringTotal> {
    const total = { judged: 0, inputTokens: 0, outputTokens: 0 };

    for (const label of source === 'local' ? await LabelStore.local(config) : newestLabels(await publishedLabels(config))) {
      if (label.source !== 'workflow' || label.subject.runId !== runId || label.judge.kind !== 'model' || isStageDecider(label.decidedBy)) continue;
      total.judged += 1;
      addUsage(total, label.judge.usage);
    }

    return total;
  },
} as const;
