import fs from 'node:fs';
import path from 'node:path';
import type { ConfinedKept, ConfinedPrompt, PromptLease, PromptResult } from '@teamai/runtime-protocol';
import { JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { copyRegularTree } from '@teamai/shared/regular-file';
import type { PromptRequest } from './conversation.js';
import type { PlaceRecord, ThreadRecord } from './journal.js';
import type { NewThread, T3 } from './t3.js';

// ─── A judge: a confined prompt ───
//
//  An idle scratch thread whose folder is filled with a read-only copy of the directory the prompt reads, then briefed
//  to read only that; its last message is the reply. Close removes the copy.
//

/**
 * What a judge's thread keeps of its directory, which `finished` reports: best effort, since only the brief and the
 * copy's file modes keep the agent there, and read, since the copy is read-only.
 */
export const JUDGE_KEPT: ConfinedKept = { level: 'best-effort', access: 'read' };

/**
 * `text` with each mention of `dir`, and of a path under it, pointed at the same place under `copy`. teamai spells
 * `dir` exactly as the prompt names it; a sibling whose name only starts with the directory's stays as it is.
 */
function pointedAtCopy({ text, dir, copy }: { text: string; dir: string; copy: string }): string {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A name character, or a dot before one, continues another name; a dot that ends a sentence does not.
  return text.replace(new RegExp(`${escaped}(?![\\w-]|\\.[\\w-])`, 'g'), () => copy);
}

/**
 * A judge's first message: which step it runs, that its folder is all it may read, and the reply's shape, then
 * teamai's prompt with each mention of the directory pointed at the copy.
 */
function judgeMessage(place: PlaceRecord, lease: PromptLease, confined: ConfinedPrompt, copy: string): string {
  const reply = confined.schema === undefined
    ? 'Reply with the JSON value the prompt asks for and no other text.'
    : `Reply with one JSON value and no other text. teamai checks it against this JSON Schema, so it decides the reply's shape: ${JSON.stringify(confined.schema)}. Where the prompt below asks for a reply of another shape, give that value where this schema places it.`;

  return `This thread runs the confined step "${lease.step}" of teamai workflow run ${place.run} (attempt ${place.attempt}). Its folder, ${copy}, is a read-only copy of the directory the step reads.`
    + ' Read only the files in it: do not read, run or change anything outside it, and change nothing in it. Do not run teamai commands.'
    + ` ${reply}\n\n${pointedAtCopy({ text: lease.prompt, dir: confined.dir, copy })}`;
}

/** Sets the mode of every directory and file under `root`, `root` included; a symlink is left alone. */
function chmodTree(root: string, modes: { dir: number; file: number }): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const at = path.join(root, entry.name);

    if (entry.isDirectory()) chmodTree(at, modes);
    else if (entry.isFile()) fs.chmodSync(at, modes.file);
  }

  fs.chmodSync(root, modes.dir);
}

const READ_ONLY = { dir: 0o555, file: 0o444 };

const WRITABLE = { dir: 0o755, file: 0o644 };

/**
 * Fills `copy`, the judge thread's folder, with what `dir` holds, then makes it read-only. Whatever an earlier attempt
 * left there goes first. A symlink would reach outside `dir`, so none is copied.
 */
async function copyReadOnly({ dir, copy }: { dir: string; copy: string }): Promise<void> {
  chmodTree(copy, WRITABLE);

  for (const name of fs.readdirSync(copy)) fs.rmSync(path.join(copy, name), { recursive: true, force: true });
  await copyRegularTree(dir, copy, { filter: (source) => !fs.lstatSync(source).isSymbolicLink() });
  chmodTree(copy, READ_ONLY);
}

/** teamai could not copy a judge's directory into its thread's folder: a fault on this machine, not in T3. */
export class JudgeCopyFailed extends Error {}

/** The person released the judge's place while T3 launched its thread, so the thread is left idle and unbriefed. */
export class JudgeReleased extends Error {}

/** The JSON value a judge replied with, in a fenced block or bare, or undefined when it is none. */
function replyValue(text: string): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A judge's result: its last message, as the JSON value it replied with. */
export async function judged(t3: T3, thread: ThreadRecord): Promise<{ ok: true; result: PromptResult } | { ok: false; why: string }> {
  const reply = await t3.lastReply(thread.threadId);
  const output = reply === undefined ? undefined : replyValue(reply);

  return output === undefined ? { ok: false, why: 'replied with no JSON value' } : { ok: true, result: { output } };
}

/** Whether `folder` is a directory, not a link to one, that holds nothing: the new scratch folder T3 makes for a launch. */
function isEmptyFolder(folder: string): boolean {
  try {
    return fs.lstatSync(folder).isDirectory() && fs.readdirSync(folder).length === 0;
  } catch {
    return false;
  }
}

/**
 * Why teamai will not copy into the folder T3 reports for a judge thread that has not run, or undefined when that folder
 * is the judge's own: on a first launch, empty, as T3 makes a scratch folder; after a restart, the one the journal
 * recorded the copy in. Any other folder may hold the member's files, which a copy would remove.
 */
function notOwnFolder({ folder, known, link }: { folder: string; known: ThreadRecord | undefined; link: string }): string | undefined {
  if (known === undefined) {
    return isEmptyFolder(folder)
      ? undefined
      : `T3 Code gave the judge thread a folder that is not empty, ${folder}, so teamai copied nothing into it, and the judge did not start. A judge's copy goes only into the new, empty folder T3 Code makes for a scratch thread. Check that your T3 Code makes scratch threads (update it if not), and run the step again. The thread, ${link}, is left idle.`;
  }

  return known.copy === folder
    ? undefined
    : `T3 Code now gives the judge thread the folder ${folder}, not ${known.copy ?? 'the one teamai would copy into'}, where teamai made its copy, so teamai copied nothing into it, and the judge did not start. The thread, ${link}, was moved in T3 Code before it ran; run the step again, and it starts a new judge thread.`;
}

/**
 * Launches a judge's thread idle in a scratch folder, unless the journal holds it (`known`), fills the folder with a
 * read-only copy of its directory, then briefs it. The folder is the judge's only when it is proven so (`notOwnFolder`):
 * only then is it journaled as the copy, which close removes whatever happens next, and filled. A thread that already
 * ran, after a restart, was copied and briefed then.
 */
export async function launchJudge({ t3, request, confined, opened, journalThread, thread, known, isReleased, linkOf }: {
  t3: T3;
  request: PromptRequest;
  confined: ConfinedPrompt;
  opened: PlaceRecord;
  journalThread: (threadId: string, copy: string | undefined, model: string | undefined) => Promise<ThreadRecord>;
  thread: NewThread;
  known: ThreadRecord | undefined;
  /** Whether the person released the judge's place meanwhile. */
  isReleased(): boolean;
  /** The link that opens a thread in T3 Code, which a refusal names it by. */
  linkOf(threadId: string): string;
}): Promise<ThreadRecord> {
  const scratch = known ? undefined : await t3.launchScratch(thread);
  const threadId = known?.threadId ?? scratch?.threadId ?? '';
  const shell = await t3.thread(threadId);

  if (shell.worktreePath === null) throw new Error(`T3 Code gave the thread ${threadId} no folder.`);
  const refused = shell.runCount === 0 ? notOwnFolder({ folder: shell.worktreePath, known, link: linkOf(threadId) }) : undefined;
  // A folder not proven the judge's is journaled as no copy: close then archives the thread, and removes nothing.
  const launched = known ?? await journalThread(threadId, refused === undefined ? shell.worktreePath : undefined, scratch?.modelSelection?.model);

  if (refused !== undefined) throw new JudgeCopyFailed(refused);

  if (shell.runCount === 0 && isReleased()) throw new JudgeReleased('teamai released the place while T3 Code launched the judge thread, so it did not brief that thread, and the judge did not start.');

  if (shell.runCount === 0) {
    try {
      await copyReadOnly({ dir: confined.dir, copy: shell.worktreePath });
    } catch (error) {
      throw new JudgeCopyFailed(`teamai could not copy ${confined.dir} into the judge thread's folder ${shell.worktreePath}, so the judge did not start: ${error instanceof Error ? error.message : String(error)}`);
    }

    await t3.send(threadId, judgeMessage(opened, request.lease, confined, shell.worktreePath), `${request.op}:brief`);
  }

  return launched;
}

/** A judge's copy is the thread's scratch folder, so the thread loses its folder with it. */
export function removeCopies(known: PlaceRecord | undefined): void {
  for (const thread of Object.values(known?.threads ?? {})) {
    if (thread.copy && fs.existsSync(thread.copy)) {
      chmodTree(thread.copy, WRITABLE);
      fs.rmSync(thread.copy, { recursive: true, force: true });
    }
  }
}
