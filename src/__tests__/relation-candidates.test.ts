/**
 * #1563 part 2: `teamai codebase --reconcile --dry-run` proposes `related:`
 * relations from team rules and docs to teamwiki code pages, derived by the
 * same term match as the product pages. Candidates are never written and
 * never shown in recall until a person copies one into the asset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileKnowledge } from '../wiki-engine/knowledge-reconciler.js';

const temporaryDirectories: string[] = [];

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-relation-candidates-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('reconcileKnowledge — relation candidates (#1563 part 2)', () => {
  it('proposes a MAPS_TO candidate from a doc whose key term appears in a code page', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'payments-overview.md'), '# Payments\n\nThe `LedgerReceipts` flow takes every payment through ledger receipts.\n');
    const codeDir = path.join(repo, 'teamwiki', 'evidence', 'code', 'pay', 'modules');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'ledger-receipts.md'), '# Ledger receipts\n\nLedgerReceipts writes receipts.\n');

    const result = await reconcileKnowledge({ wikiRoot: path.join(repo, 'teamwiki'), dryRun: true });

    expect(result.relationCandidates).toEqual([
      {
        from: 'docs/payments-overview.md',
        to: 'teamwiki/evidence/code/pay/modules/ledger-receipts.md',
        relation: 'MAPS_TO',
        term: 'LedgerReceipts',
        confidenceScore: expect.closeTo(0.9, 5) as number,
      },
    ]);
    // The proposal is never written into the graph.
    expect(result.graphEdges).toEqual([]);
  });

  it('proposes candidates from rules, never from a teamwiki page', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'rules', 'payments.md'), 'Every payment goes through `LedgerReceipts`.\n');
    const codeDir = path.join(repo, 'teamwiki', 'evidence', 'code', 'pay', 'modules');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'ledger-receipts.md'), '# Ledger receipts\n\nLedgerReceipts writes receipts.\n');

    const result = await reconcileKnowledge({ wikiRoot: path.join(repo, 'teamwiki'), dryRun: true });

    expect(result.relationCandidates.map((c) => c.from)).toEqual(['rules/payments.md']);
    expect(result.relationCandidates[0]?.to).toBe('teamwiki/evidence/code/pay/modules/ledger-receipts.md');
  });

  it('a standalone output tree without rules or docs proposes nothing', async () => {
    const repo = makeRepo();
    const codeDir = path.join(repo, 'teamwiki', 'evidence', 'code', 'pay', 'modules');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'ledger-receipts.md'), '# Ledger receipts\n\nLedgerReceipts writes receipts.\n');

    const result = await reconcileKnowledge({ wikiRoot: path.join(repo, 'teamwiki'), dryRun: true });

    expect(result.relationCandidates).toEqual([]);
  });
});
