import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerReview, assertHumanTerminal, requestReview, requireReviews, reviewHistory, type TaskReview } from '../documents/reviews.js';
import { SDLC_TYPES, type SdlcStage } from '../documents/artifacts.js';

let root: string;
let task: TaskReview;
function git(...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function document(stage: SdlcStage, text = 'Reviewed task content') {
  await fs.mkdir(path.join(root, 'intent/ws/task'), { recursive: true });
  await fs.writeFile(path.join(root, `intent/ws/task/${stage}.md`), `---\ntype: ${SDLC_TYPES[stage]}\nsources: []\n---\n${text}\n`);
  git('add', '.'); git('commit', '-qm', stage);
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-document-review-')));
  task = { root, workspace: 'ws', task: 'task' };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'review@example.invalid');
  await document('intent');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('independent version-bound reviews', () => {
  it('keeps identity and versions, requires each human decision and invalidates downstream reviews', async () => {
    await expect(requestReview(task, 'spec')).rejects.toThrow('intent requires human');
    for (const stage of ['intent', 'spec', 'plan'] as const) {
      if (stage !== 'intent') await document(stage);
      const request = await requestReview(task, stage);
      expect(request.artifacts).toHaveLength(['intent', 'spec', 'plan'].indexOf(stage) + 1);
      await answerReview(task, request.id, 'approve', `owner-${stage}`);
    }
    expect((await requireReviews(task, 'plan')).map((review) => review.answer?.reviewer)).toEqual(['owner-intent', 'owner-spec', 'owner-plan']);
    await fs.writeFile(path.join(root, 'code.txt'), 'code only'); git('add', '.'); git('commit', '-qm', 'implementation');
    const old = (await requireReviews(task, 'plan')).at(-1)!;
    expect((await requestReview(task, 'plan')).id).toBe(old.id);
    await document('intent', 'Changed intent');
    await expect(requireReviews(task, 'plan')).rejects.toThrow('Document changed');
    const revised = await requestReview(task, 'intent');
    await answerReview(task, revised.id, 'approve', 'product-owner');
    await expect(requireReviews(task, 'plan')).rejects.toThrow('spec must be reviewed again');
    expect(await reviewHistory(task)).toHaveLength(4);
  });

  it('rejects stale and duplicate answers, and records rejections and cancellation without overwriting history', async () => {
    const first = await requestReview(task, 'intent');
    expect((await requestReview(task, 'intent')).id).toBe(first.id);
    await document('intent', 'New request');
    const next = await requestReview(task, 'intent');
    await expect(answerReview(task, first.id, 'approve', 'owner')).rejects.toThrow('replaced');
    await answerReview(task, next.id, 'reject', 'owner');
    await expect(answerReview(task, next.id, 'approve', 'owner')).rejects.toThrow('already has an answer');
    await expect(requireReviews(task, 'intent')).rejects.toThrow('requires human');
    const retry = await requestReview(task, 'intent');
    await answerReview(task, retry.id, 'cancel', 'owner');
    expect((await reviewHistory(task)).map((record) => record.answer?.decision)).toEqual([undefined, 'reject', 'cancel']);
  });

  it('cannot approve uncommitted changes and shares history across worktrees of the business repository', async () => {
    const requested = await requestReview(task, 'intent');
    const file = path.join(root, 'intent/ws/task/intent.md');
    const original = await fs.readFile(file, 'utf8');
    await fs.appendFile(file, 'Uncommitted change');
    await expect(answerReview(task, requested.id, 'approve', 'owner')).rejects.toThrow('Document changed');
    await fs.writeFile(file, original);
    await answerReview(task, requested.id, 'approve', 'owner');
    const copy = path.join(root, '.git', 'review-worktree');
    git('worktree', 'add', '-q', '-b', 'work', copy);
    expect((await requireReviews({ ...task, root: copy }, 'intent'))[0]?.id).toBe(requested.id);
    expect(git('status', '--porcelain')).toBe('');
    await expect(requireReviews({ ...task, task: 'another' }, 'intent')).rejects.toThrow('requires human');
  });

  it('refuses an Agent or a pipe at the CLI human boundary', () => {
    expect(() => assertHumanTerminal({}, false)).toThrow('human confirmation');
    expect(() => assertHumanTerminal({ CODEX_THREAD_ID: 'agent' }, true)).toThrow('human confirmation');
    expect(() => assertHumanTerminal({ TEAMAI_WORKFLOW_ATTEMPT: 'old-agent-attempt' }, true)).toThrow('human confirmation');
    expect(() => assertHumanTerminal({}, true)).not.toThrow();
  });
});
