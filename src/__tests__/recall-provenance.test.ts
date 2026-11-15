import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ATTEMPT_ENV } from '../launch-context.js';
import { RUN_DIR_ENV } from '@teamai/runtime-protocol';
import { readRecallObservation, recordRecallIndexes, RECALL_TRACE_ENV } from '../recall-provenance.js';
import type { SearchIndex } from '../types.js';

it('distinguishes no query, unknown provenance and multiple observed revisions per attempt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teamai-recall-provenance-'));

  try {
    const attempt = 'a12345678';
    const env = { [ATTEMPT_ENV]: `r12345678/${attempt}`, [RUN_DIR_ENV]: dir, [RECALL_TRACE_ENV]: '1' };
    const teamRevision = 'a'.repeat(40);
    const learningsRevision = 'b'.repeat(40);
    const index: SearchIndex = { builtAt: 'unused', elapsedMs: 0, entries: [], df: {} };
    expect(await readRecallObservation(dir, attempt)).toEqual({ queried: false, unavailable: false, indexes: [] });
    await recordRecallIndexes(env, [index]);
    await recordRecallIndexes(env, [{ ...index, provenance: { teamRevision, learningsRevision } }]);
    await recordRecallIndexes(env, [{ ...index, provenance: { teamRevision, learningsRevision: null } }]);
    await recordRecallIndexes(env, [{ ...index, provenance: { teamRevision, learningsRevision } }]);
    expect(await readRecallObservation(dir, attempt)).toEqual({
      queried: true, unavailable: true, indexes: [{ teamRevision, learningsRevision }, { teamRevision, learningsRevision: null }],
    });
    expect(await readRecallObservation(dir, 'other')).toEqual({ queried: false, unavailable: false, indexes: [] });
    const raw = await readFile(path.join(dir, 'recall-provenance', `${attempt}.jsonl`), 'utf8');
    expect(raw).not.toMatch(/builtAt|entries|elapsedMs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
