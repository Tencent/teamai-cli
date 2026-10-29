import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { acquireLock, releaseLock } from '../update.js';
import { git } from '../utils/git-command.js';
import { ATTEMPT_ENV, LAUNCHED_BY_ENV } from '../launch-context.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { ArtifactsSchema, checkTaskDocuments, checkTaskLocation, taskDirectory, type SdlcStage } from './artifacts.js';

const Stage = z.enum(['intent', 'spec', 'plan']);
const Id = z.string().uuid();
const Decision = z.object({
  decision: z.enum(['approve', 'reject', 'cancel']),
  reviewer: z.string().trim().min(1),
  at: z.string().datetime(),
  channel: z.literal('terminal'),
}).strict();
const Request = z.object({
  schema: z.literal('teamai.sdlc-review/v1'), id: Id,
  sequence: z.number().int().positive(), workspace: z.string(), task: z.string(), stage: Stage,
  requestedAt: z.string().datetime(), artifacts: ArtifactsSchema,
  parents: z.record(Stage, Id),
}).strict();
export type ReviewRequest = z.infer<typeof Request>;
export type ReviewRecord = ReviewRequest & { answer?: z.infer<typeof Decision> };
const stages = Stage.options;
export interface TaskReview { root: string; workspace: string; task: string }

/** Local attribution, not SSO: an Agent process or a pipe cannot answer a required human review. */
export function assertHumanTerminal(env: NodeJS.ProcessEnv, tty: boolean): void {
  const marker = ['CODEX_THREAD_ID', 'CLAUDECODE', ATTEMPT_ENV, LAUNCHED_BY_ENV, ...AGENT_SESSION_ENV].find((name) => env[name]);
  if (!tty || marker) throw new Error('Required human confirmation must be answered in your own interactive terminal, outside an Agent session.');
}

/** A repository's Git directory is shared by its worktrees. No review metadata enters the Markdown collection. */
async function directory({ root, workspace, task }: TaskReview): Promise<string> {
  await checkTaskLocation(root, workspace, task);
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) throw new Error('Cannot locate the business repository Git directory.');
  let dir = await realpath(common.stdout.trim());
  for (const component of ['teamai', 'document-reviews', ...taskDirectory(workspace, task).split('/').slice(1)]) {
    dir = path.join(dir, component);
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Review storage must be a directory without symbolic links.');
  }
  return dir;
}

async function readRecords(dir: string, task: TaskReview): Promise<ReviewRecord[]> {
  const records: ReviewRecord[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.request.json')) continue;
    const request = Request.parse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
    if (name !== `${request.id}.request.json` || request.workspace !== task.workspace || request.task !== task.task) throw new Error('Review storage contains a mismatched request.');
    let answer: z.infer<typeof Decision> | undefined;
    try { answer = Decision.parse(JSON.parse(await readFile(path.join(dir, `${request.id}.answer.json`), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    records.push({ ...request, ...(answer ? { answer } : {}) });
  }
  if (new Set(records.map((record) => record.sequence)).size !== records.length) throw new Error('Review history contains conflicting sequence numbers.');
  return records.sort((a, b) => a.sequence - b.sequence);
}

async function locked<T>(task: TaskReview, action: (dir: string, records: ReviewRecord[]) => Promise<T>): Promise<T> {
  const dir = await directory(task);
  const lock = path.join(dir, 'review.lock');
  if (!await acquireLock(lock)) throw new Error('Document review is busy. Retry after the current operation finishes.');
  try { return await action(dir, await readRecords(dir, task)); }
  finally { await releaseLock(lock); }
}

function latest(records: ReviewRecord[], stage: SdlcStage): ReviewRecord | undefined {
  return records.findLast((record) => record.stage === stage);
}

async function approved(task: TaskReview, records: ReviewRecord[], stage: SdlcStage): Promise<ReviewRecord[]> {
  const accepted: ReviewRecord[] = [];
  for (const name of stages.slice(0, stages.indexOf(stage) + 1)) {
    const current = latest(records, name);
    if (!current || current.answer?.decision !== 'approve') throw new Error(`${name} requires human confirmation of its latest request.`);
    for (const parent of accepted) {
      if (current.parents[parent.stage] !== parent.id) throw new Error(`${name} must be reviewed again after ${parent.stage} changed.`);
    }
    await checkTaskDocuments(task.root, task.workspace, task.task, name, current.artifacts);
    accepted.push(current);
  }
  return accepted;
}

/** A retry reuses an identical pending or approved request. A rejected/cancelled request remains in history. */
export async function requestReview(task: TaskReview, stage: SdlcStage): Promise<ReviewRecord> {
  Stage.parse(stage);
  return locked(task, async (dir, records) => {
    const previous = stages[stages.indexOf(stage) - 1];
    const parents = previous ? await approved(task, records, previous) : [];
    const artifacts = await checkTaskDocuments(task.root, task.workspace, task.task, stage);
    const references = Object.fromEntries(parents.map((parent) => [parent.stage, parent.id]));
    const current = latest(records, stage);
    if (current && (!current.answer || current.answer.decision === 'approve')
      && JSON.stringify(current.artifacts.map(({ path: file, blob }) => ({ path: file, blob }))) === JSON.stringify(artifacts.map(({ path: file, blob }) => ({ path: file, blob }))) && JSON.stringify(current.parents) === JSON.stringify(references)) return current;
    const request = Request.parse({ schema: 'teamai.sdlc-review/v1', id: randomUUID(), sequence: (records.at(-1)?.sequence ?? 0) + 1,
      workspace: task.workspace, task: task.task, stage, requestedAt: new Date().toISOString(), artifacts, parents: references });
    await writeFile(path.join(dir, `${request.id}.request.json`), JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return request;
  });
}

/** Called only after the CLI displayed these versions and received an explicit terminal answer. Rechecks under the lock. */
export async function answerReview(task: TaskReview, id: string, decision: z.infer<typeof Decision>['decision'], reviewer: string): Promise<ReviewRecord> {
  Id.parse(id);
  return locked(task, async (dir, records) => {
    const request = records.find((record) => record.id === id);
    if (!request || latest(records, request.stage)?.id !== id) throw new Error('This review request is missing or has been replaced. Read the latest request.');
    if (request.answer) throw new Error('This request already has an answer. Request a new review to change the decision.');
    if (decision === 'approve') {
      const previous = stages[stages.indexOf(request.stage) - 1];
      const parents = previous ? await approved(task, records, previous) : [];
      for (const parent of parents) if (request.parents[parent.stage] !== parent.id) throw new Error('An upstream review changed. Request this stage again.');
      await checkTaskDocuments(task.root, task.workspace, task.task, request.stage, request.artifacts);
    }
    const answer = Decision.parse({ decision, reviewer, at: new Date().toISOString(), channel: 'terminal' });
    await writeFile(path.join(dir, `${id}.answer.json`), JSON.stringify(answer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ...request, answer };
  });
}

export async function requireReviews(task: TaskReview, stage: SdlcStage): Promise<ReviewRecord[]> {
  Stage.parse(stage);
  return locked(task, (_dir, records) => approved(task, records, stage));
}

export async function reviewHistory(task: TaskReview): Promise<ReviewRecord[]> {
  return locked(task, async (_dir, records) => records);
}
