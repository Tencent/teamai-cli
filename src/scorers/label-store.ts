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
import { AttemptStore, isRunAttempt, scoresDir } from './attempts.js';
import { labelId, labelVersion, newestLabels, parseScoreLabel, parseScoreLabels, type JudgeUsage, type ScoreLabel } from './label.js';

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

/** What Workflow Runs shows of a label: never its reasoning, judge, or usage. */
export type PassScore = Pick<ScoreLabel, 'scorer' | 'label' | 'passed'>;

function addUsage(total: { inputTokens: number; outputTokens: number }, usage: JudgeUsage | undefined): void {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
}

export const LabelStore = {
  /**
   * The outbox entry commits the label: a failure before it records no label, and one after it leaves a label that
   * `local` reads and `publish` still sends. Returns the label's `id` and the `version` that names its reasoning file.
   * `prompt`, the redacted first prompt of a judged session, heads the reasoning file so a member finds it with grep.
   * A hand label has no `reasoning`, and no reasoning file.
   */
  async append(config: LocalConfig, label: ScoreLabel, reasoning: string | undefined, prompt?: string): Promise<{ id: string; version: string }> {
    const id = labelId(label);
    const version = labelVersion(label);
    if (reasoning !== undefined) await writeFileAtomic(reasoningPath(config, version), reasoningText(label, reasoning, prompt));
    await writeJsonAtomic(path.join(pendingDir(config), `${id}.json`), label);
    await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
    return { id, version };
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
        await AttemptStore.locked(config, async () => {
          const appended = new Set(parseScoreLabels(await readFileSafe(labelsFile(config)) ?? '').map(labelVersion));
          for (const { id, label } of pending) {
            const file = path.join(pendingDir(config), `${id}.json`);
            const current = parseScoreLabel(JSON.parse(await readFileSafe(file) ?? 'null'));
            if (current?.scoredAt !== label.scoredAt) continue;
            if (!appended.has(labelVersion(label))) await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
            await fs.rm(file, { force: true });
          }
        });
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
   * reports checkout as it is. Per pass and scorer, a hand label beats a model label, and of those the newest across
   * rubric versions is shown.
   */
  async ofRuns(config: LocalConfig, runIds: readonly string[], options: { published: boolean }): Promise<Map<string, Map<string, PassScore[]>>> {
    const wanted = new Set(runIds);
    const labels = newestLabels([
      ...await LabelStore.local(config),
      ...options.published ? await publishedLabels(config) : [],
    ]);
    const outranks = (label: ScoreLabel, other: ScoreLabel): boolean => (label.judge.kind === other.judge.kind
      ? label.scoredAt > other.scoredAt
      : label.judge.kind === 'human');
    const byRun = new Map<string, Map<string, ScoreLabel[]>>();
    for (const label of labels) {
      if (label.source !== 'workflow' || !wanted.has(label.subject.runId)) continue;
      const passes = byRun.get(label.subject.runId) ?? new Map<string, ScoreLabel[]>();
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
      key, shown.map((label) => ({ scorer: label.scorer, label: label.label, passed: label.passed })),
    ]))]));
  },

  /** What judging run `runId` cost: every attempt on this machine, or, for a published run, its labels. */
  async scoringTotal(config: LocalConfig, runId: string, source: 'local' | 'published'): Promise<{ judged: number; inputTokens: number; outputTokens: number }> {
    const total = { judged: 0, inputTokens: 0, outputTokens: 0 };
    if (source === 'local') {
      for (const attempts of (await AttemptStore.read(config)).values()) {
        for (const attempt of attempts) {
          if (!isRunAttempt(attempt) || attempt.subject.runId !== runId) continue;
          total.judged += 1;
          addUsage(total, attempt.usage);
        }
      }
      return total;
    }
    for (const label of newestLabels(await publishedLabels(config))) {
      if (label.source !== 'workflow' || label.subject.runId !== runId || label.judge.kind !== 'model') continue;
      total.judged += 1;
      addUsage(total, label.judge.usage);
    }
    return total;
  },
} as const;
