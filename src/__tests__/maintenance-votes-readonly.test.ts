// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

import { computeAllConfidence } from '../maintenance/confidence.js';
import { findStaleEntries, findRelatedAdoptedLearnings } from '../maintenance/quality-update.js';
import { findPromotionCandidates } from '../maintenance/promote.js';
import { loadUserVotes } from '../votes.js';
import type { UserVotes } from '../types.js';

// `recall maintenance` (every mode) and `recall promote` only aggregate votes,
// but they read them through loadUserVotes, which persists the v1 → v2 upgrade.
// Scanning therefore rewrote every v1 votes file in the team repo — including
// under --dry-run, which promises no changes (issue #900, C7).

let tmpDir: string;
let votesDir: string;
let learningsDir: string;
let docsDir: string;

/** A v1 file with enough recalls from two users to reach the stale/promote paths. */
function writeV1Votes(user: string, docIds: string[]): string {
  const v1: UserVotes = {
    votes: Object.fromEntries(docIds.map((id) => [id, { at: '2026-06-01T00:00:00Z' }])),
  };
  const filePath = path.join(votesDir, `${user}.yaml`);
  fs.writeFileSync(filePath, YAML.stringify(v1));
  return filePath;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-votes-readonly-'));
  votesDir = path.join(tmpDir, 'votes');
  learningsDir = path.join(tmpDir, 'learnings');
  docsDir = path.join(tmpDir, 'docs');
  for (const dir of [votesDir, learningsDir, docsDir]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(docsDir, 'guide.md'), '# guide\n');
  fs.writeFileSync(
    path.join(learningsDir, 'lesson.md'),
    '---\ndocId: lesson\ncreated: 2026-06-01T00:00:00Z\n---\n\n# lesson\n',
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recall maintenance scans never rewrite a v1 votes file (#900 C7)', () => {
  it('computeAllConfidence aggregates v1 votes and leaves them on disk', async () => {
    writeV1Votes('alice', ['guide', 'lesson']);
    writeV1Votes('bob', ['guide']);
    const before = snapshot(votesDir);

    const confidence = await computeAllConfidence(votesDir);

    // Saw the v1 data: it is not passing by reading nothing.
    expect(confidence.has('guide')).toBe(true);
    expect(snapshot(votesDir)).toEqual(before);
  });

  it('findStaleEntries and findRelatedAdoptedLearnings leave them on disk', async () => {
    writeV1Votes('alice', ['guide']);
    writeV1Votes('bob', ['guide']);
    const before = snapshot(votesDir);

    await findStaleEntries(votesDir, { docs: docsDir }, { minRecalled: 1, minUsers: 1 });
    await findRelatedAdoptedLearnings(
      { docId: 'guide', path: path.join(docsDir, 'guide.md'), filename: 'guide.md' } as never,
      votesDir,
      [learningsDir],
    );

    expect(snapshot(votesDir)).toEqual(before);
  });

  it('findPromotionCandidates leaves them on disk', async () => {
    writeV1Votes('alice', ['lesson']);
    writeV1Votes('bob', ['lesson']);
    const before = snapshot(votesDir);

    await findPromotionCandidates([learningsDir], votesDir, undefined);

    expect(snapshot(votesDir)).toEqual(before);
  });

  // The write path still upgrades the file, so the assertions above are not
  // passing because nothing in this fixture can ever be migrated.
  it('control: loadUserVotes still persists the upgrade', async () => {
    const filePath = writeV1Votes('alice', ['guide']);

    await loadUserVotes(filePath);

    expect(YAML.parse(fs.readFileSync(filePath, 'utf-8')).version).toBe(2);
  });
});
