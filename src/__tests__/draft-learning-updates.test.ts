import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DraftLearningUpdates } from '../maintenance/quality-update.js';
import type { UserVotesV2 } from '../types.js';

let repo: string;
let votesDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-draft-updates-'));
  votesDir = path.join(repo, 'votes');
  fs.mkdirSync(votesDir);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Two members recalled `docId` often and adopted it never. */
function recalledOften(docId: string): void {
  for (const user of ['alice', 'bob']) {
    const votes: UserVotesV2 = { version: 2, votes: { [docId]: { recalled_count: 3, upvoted_count: 0, last_recalled_at: '2026-10-01T00:00:00Z' } }, deltas: {} };
    fs.writeFileSync(path.join(votesDir, `${user}.yaml`), YAML.stringify(votes));
  }
}

describe('the stale step of teamai-draft-learning-updates', () => {
  it('finds a skill, which recall names after its directory', async () => {
    fs.mkdirSync(path.join(repo, 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nDeploy it.\n');
    recalledOften('deploy');

    const { entries } = await DraftLearningUpdates.stale(votesDir, repo);

    expect(entries).toEqual([{
      doc_id: 'deploy', path: path.join(repo, 'skills', 'deploy', 'SKILL.md'), type: 'skills', recalled_count: 6, upvoted_count: 0, user_count: 2,
    }]);
  });
});
