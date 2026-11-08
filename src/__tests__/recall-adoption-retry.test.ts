import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

import { adoptionCandidates, creditAdoptedDocs, creditAdoptionVerdicts, drainRecallLog, recallSessions } from '../recall-adoption.js';
import { appendRecallLine, readRecallLog, recallLogPath } from '../recall-log.js';
import { getVotesDir, type LocalConfig } from '../types.js';
import { countRecalledSessions, readUserVotes } from '../votes.js';
import { acquireLock, releaseLock } from '../update.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function recalledSession(ts = new Date().toISOString()): Promise<{ config: LocalConfig; votePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-retry-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const config: LocalConfig = {
    repo: { localPath: root, remote: 'https://example.test/team.git' },
    username: 'member', scope: 'project', additionalRoles: [], dataHome: root,
  };
  await appendRecallLine(config, {
    kind: 'run', ts, run: 'run-a', session: 'root-a', unambiguous: true, via: 'env',
    docs: [{ key: 'doc-a', path: path.join(root, 'doc.md'), eligible: true, scope: 'project', score: 1 }],
  });

  return { config, votePath: path.join(getVotesDir(config), 'member.yaml') };
}

it('counts one recalled session when reducers overlap', async () => {
  const { config, votePath } = await recalledSession();

  await Promise.all([creditAdoptedDocs(config, 'root-a'), creditAdoptedDocs(config, 'root-a')]);

  expect((await readUserVotes(votePath)).votes['doc-a']?.recalled_session_count).toBe(1);
});

it('retries a pending adoption verdict without another upvote', async () => {
  const { config, votePath } = await recalledSession();
  const verdicts = [{ doc: 'doc-a', adopted: true }];

  await creditAdoptionVerdicts(config, 'root-a', verdicts);
  // The counter write survived, but the journal's completion marker did not.
  const pending = (await readRecallLog(config)).filter((line) => line.kind !== 'credit' || line.votes !== 'written');
  await fs.writeFile(recallLogPath(config), pending.map((line) => JSON.stringify(line) + '\n').join(''));
  await creditAdoptionVerdicts(config, 'root-a', verdicts);

  expect((await readUserVotes(votePath)).votes['doc-a']).toMatchObject({ judged_count: 1, upvoted_count: 1, judge_upvoted_count: 1 });
});

it('marks a credited read adopted again without another upvote when its journal markers were lost', async () => {
  const { config, votePath } = await recalledSession();
  await appendRecallLine(config, { kind: 'evidence', ts: new Date().toISOString(), id: 'read-a', session: 'root-a', path: path.join(config.repo.localPath, 'doc.md'), status: 'success', simple: true });
  await creditAdoptedDocs(config, 'root-a');
  // The votes write survived, but the journal's consumed and credit markers did not.
  const unmarked = (await readRecallLog(config)).filter((line) => line.kind !== 'consumed' && line.kind !== 'credit');
  await fs.writeFile(recallLogPath(config), unmarked.map((line) => JSON.stringify(line) + '\n').join(''));

  await creditAdoptedDocs(config, 'root-a');

  expect((await readUserVotes(votePath)).votes['doc-a']?.upvoted_count).toBe(1);
  expect(await recallSessions(config, 1)).toMatchObject([{ session: 'root-a', adopted: 1 }]);
});

it('keeps a judged document from earning a read credit after its journal markers are removed', async () => {
  const { config, votePath } = await recalledSession();
  await creditAdoptionVerdicts(config, 'root-a', [{ doc: 'doc-a', adopted: true }]);
  const runs = (await readRecallLog(config)).filter((line) => line.kind === 'run');
  await fs.writeFile(recallLogPath(config), runs.map((line) => JSON.stringify(line) + '\n').join(''));
  await appendRecallLine(config, { kind: 'evidence', ts: new Date().toISOString(), id: 'read-a', session: 'root-a', path: path.join(config.repo.localPath, 'doc.md'), status: 'success', simple: true });

  await creditAdoptedDocs(config, 'root-a');

  expect((await readUserVotes(votePath)).votes['doc-a']?.upvoted_count).toBe(1);
});

it('does not judge an ignored document again after its journal markers are removed', async () => {
  const { config, votePath } = await recalledSession();
  await creditAdoptionVerdicts(config, 'root-a', [{ doc: 'doc-a', adopted: false }]);
  const runs = (await readRecallLog(config)).filter((line) => line.kind === 'run');
  await fs.writeFile(recallLogPath(config), runs.map((line) => JSON.stringify(line) + '\n').join(''));

  expect(await adoptionCandidates(config, 'root-a')).toEqual([]);
  expect(await creditAdoptionVerdicts(config, 'root-a', [{ doc: 'doc-a', adopted: true }])).toEqual([]);
  expect((await readUserVotes(votePath)).votes['doc-a']).toMatchObject({ judged_count: 1, upvoted_count: 0 });
});

it('keeps an old pending verdict retryable while the votes file is busy', async () => {
  const { config, votePath } = await recalledSession();
  await appendRecallLine(config, {
    kind: 'credit', ts: new Date(Date.now() - 31 * DAY_MS).toISOString(), id: 'pending-a',
    session: 'root-a', doc: 'doc-a', source: 'judge', adopted: true, votes: 'pending',
  });
  await fs.mkdir(path.dirname(votePath), { recursive: true });
  expect(await acquireLock(`${votePath}.lock`)).toBe(true);

  try {
    await drainRecallLog(config);
  } finally {
    await releaseLock(`${votePath}.lock`);
  }

  await drainRecallLog(config);

  expect((await readUserVotes(votePath)).votes['doc-a']).toMatchObject({ judged_count: 1, upvoted_count: 1 });
});

it('forgets a recalled session at the pull after the recall log stopped naming it', async () => {
  const { config, votePath } = await recalledSession();
  await creditAdoptedDocs(config, 'root-a');
  await fs.writeFile(recallLogPath(config), '');

  await drainRecallLog(config);

  const votes = await readUserVotes(votePath);
  expect(votes.recalledSessions?.['root-a']).toBeUndefined();
  expect(votes.votes['doc-a']?.recalled_session_count).toBe(1);
});

it('keeps a recalled session through the pull whose retention drops its lines', async () => {
  const ts = new Date(Date.now() - 31 * DAY_MS).toISOString();
  const { config, votePath } = await recalledSession(ts);
  await creditAdoptedDocs(config, 'root-a');
  const counted31DaysAgo = (await readRecallLog(config)).map((line) => (line.kind === 'counted' ? { ...line, ts } : line));
  await fs.writeFile(recallLogPath(config), counted31DaysAgo.map((line) => JSON.stringify(line) + '\n').join(''));

  await drainRecallLog(config);
  // A reducer that read the run before that retention, but not its counted marker, counts it late.
  await countRecalledSessions({ votePath, sessionId: 'root-a', docIds: ['doc-a'] });

  expect(await readRecallLog(config)).toEqual([]);
  expect((await readUserVotes(votePath)).votes['doc-a']?.recalled_session_count).toBe(1);
});

it('credits no verdict for a session the recall log no longer names', async () => {
  const { config, votePath } = await recalledSession();
  // The score run asked its question, then waited past the recall log's retention.
  await fs.writeFile(recallLogPath(config), '');

  expect(await creditAdoptionVerdicts(config, 'root-a', [{ doc: 'doc-a', adopted: true }])).toEqual([]);
  expect((await readUserVotes(votePath)).votes['doc-a']).toBeUndefined();
});

it('forgets an adoption credit at the pull after the recall log stopped naming its session', async () => {
  const { config, votePath } = await recalledSession();
  await creditAdoptionVerdicts(config, 'root-a', [{ doc: 'doc-a', adopted: false }]);
  await fs.writeFile(recallLogPath(config), '');

  await drainRecallLog(config);

  const votes = await readUserVotes(votePath);
  expect(votes.adoptionCredits?.['root-a']).toBeUndefined();
  expect(votes.votes['doc-a']).toMatchObject({ judged_count: 1 });
});
