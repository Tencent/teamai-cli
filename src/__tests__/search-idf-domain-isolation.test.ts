import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { buildIndex, loadIndex, search } from '../utils/search-index.js';

// ---------------------------------------------------------------------------
// IDF domain isolation and query-domain regression tests.
// ---------------------------------------------------------------------------

// N_TECH / N_OPS are used across multiple tests; kept as module-level consts
// so the ratio (3:12) is declared once and easy to adjust.
const N_TECH = 3;
const N_OPS = 12;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Produces a minimal valid frontmatter + body markdown string.
 * Tags are written as a YAML flow sequence: [tag1, tag2, ...]
 */
const learningDoc = (title: string, tags: string[], body: string): string =>
  `---\ntitle: ${title}\nauthor: t\ndate: 2026-01-01\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`;

/**
 * Writes `docs` (filename → content) into `dir`, builds an index, and returns
 * the loaded SearchIndex. Throws if the index cannot be loaded.
 */
async function buildScopedIndex(
  learningsDir: string,
  indexPath: string,
  docs: Record<string, string>,
): Promise<NonNullable<Awaited<ReturnType<typeof loadIndex>>>> {
  await fse.ensureDir(learningsDir);
  for (const [filename, content] of Object.entries(docs)) {
    await fse.writeFile(path.join(learningsDir, filename), content);
  }
  await buildIndex({ learningsDir, indexPath });
  const index = await loadIndex(indexPath);
  if (!index) throw new Error(`Failed to load index from ${indexPath}`);
  return index;
}

// ---------------------------------------------------------------------------
// Module-level tmp paths; initialised in beforeEach, cleaned in afterEach.
// ---------------------------------------------------------------------------
let tmpDir: string;
let indexPath: string;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-idf-domain-'));
  indexPath = path.join(tmpDir, 'search-index.json');
});

afterEach(async () => {
  await fse.remove(tmpDir);
});

// ---------------------------------------------------------------------------
describe('IDF domain isolation (regression)', () => {
  // -------------------------------------------------------------------------
  // Keep the aggregate map for compatibility, and build isolated maps for scoring.
  // -------------------------------------------------------------------------
  it('builds document-frequency maps for each knowledge domain', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');

    // 2 technical entries (tags from TECHNICAL_TAGS: api, typescript)
    // 2 ops entries (tags from OPS_TAGS: k8s, deploy)
    // All share the token "timeout" in their body.
    const docs: Record<string, string> = {
      'tech-1.md': learningDoc('Tech one', ['api', 'typescript'], 'timeout retry config details here'),
      'tech-2.md': learningDoc('Tech two', ['api', 'debug'], 'timeout retry config more here'),
      'ops-1.md': learningDoc('Ops one', ['k8s', 'deploy'], 'timeout retry config infra stuff'),
      'ops-2.md': learningDoc('Ops two', ['monitor', 'deploy'], 'timeout retry config more ops'),
    };

    const index = await buildScopedIndex(learningsDir, indexPath, docs);

    expect(index.df).toBeDefined();
    expect(index.dfByDomain).toBeDefined();
    expect(index.entries.length).toBe(4);
    expect(index.df!['timeout']).toBe(4);
    expect(index.dfByDomain?.technical?.timeout).toBe(2);
    expect(index.dfByDomain?.ops?.timeout).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Adding unrelated entries must not change the scores of technical entries.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Confirm the regression fixture returns the same technical entry from both indexes.
  // -------------------------------------------------------------------------
  it('fixture sanity: both indexes return the tracked technical entry', async () => {
    const dirA = path.join(tmpDir, 'learnings-sanity-A');
    const idxPathA = path.join(tmpDir, 'index-sanity-A.json');

    const techDocs: Record<string, string> = {};
    for (let i = 0; i < N_TECH; i++) {
      techDocs[`tech-${i}.md`] = learningDoc(
        `Timeout retry API ${i}`,
        ['api', 'typescript', 'debug'],
        `timeout retry config techonly details ${i}`,
      );
    }

    const indexA = await buildScopedIndex(dirA, idxPathA, techDocs);

    const dirB = path.join(tmpDir, 'learnings-sanity-B');
    const idxPathB = path.join(tmpDir, 'index-sanity-B.json');

    const techAndOpsDocs: Record<string, string> = { ...techDocs };
    for (let i = 0; i < N_OPS; i++) {
      techAndOpsDocs[`ops-${i}.md`] = learningDoc(
        `Deploy monitor ops ${i}`,
        ['k8s', 'deploy', 'monitor'],
        `timeout retry config opsonly infrastructure ${i}`,
      );
    }

    const indexB = await buildScopedIndex(dirB, idxPathB, techAndOpsDocs);

    const query = 'timeout retry api';
    const resultsA = search(query, indexA);
    const resultsB = search(query, indexB);

    const resA = resultsA.find((r) => r.entry.filename === 'tech-0.md');
    const resB = resultsB.find((r) => r.entry.filename === 'tech-0.md');

    expect(resA).toBeDefined();
    expect(resA!.score).toBeGreaterThan(0);
    expect(resB).toBeDefined();
    expect(resB!.score).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // A second fixture uses many shared tokens to guard the exact score, not just order.
  // -------------------------------------------------------------------------
  it(
    'technical entry scores are unaffected by unrelated ops entries',
    async () => {
      // --- Index A: only N_TECH technical entries ---
      const dirA = path.join(tmpDir, 'learnings-A');
      const idxPathA = path.join(tmpDir, 'index-A.json');

      const techDocs: Record<string, string> = {};
      for (let i = 0; i < N_TECH; i++) {
        // Each tech doc: title contains "timeout", body shares SHARED_TOKENS.
        // Unique body token "techonly" ensures there is an exclusive technical token.
        techDocs[`tech-${i}.md`] = learningDoc(
          `Timeout retry API ${i}`,
          ['api', 'typescript', 'debug'],
          `timeout retry config techonly details ${i}`,
        );
      }

      const indexA = await buildScopedIndex(dirA, idxPathA, techDocs);

      // --- Index B: same N_TECH technical entries PLUS N_OPS ops entries ---
      const dirB = path.join(tmpDir, 'learnings-B');
      const idxPathB = path.join(tmpDir, 'index-B.json');

      // Exact same tech docs
      const techAndOpsDocs: Record<string, string> = { ...techDocs };
      for (let i = 0; i < N_OPS; i++) {
        // Ops docs also contain the shared tokens to expose cross-domain leakage.
        // They have distinct titles and ops-domain tags.
        techAndOpsDocs[`ops-${i}.md`] = learningDoc(
          `Deploy monitor ops ${i}`,
          ['k8s', 'deploy', 'monitor'],
          `timeout retry config opsonly infrastructure ${i}`,
        );
      }

      const indexB = await buildScopedIndex(dirB, idxPathB, techAndOpsDocs);

      // Query: purely technical tokens → inferQueryDomain returns 'technical'
      // DOMAIN_WEIGHT.technical.technical === 1.0 for both indexes
      // → domain multiplier is identical, so any score difference is purely IDF.
      const query = 'timeout retry api';

      const resultsA = search(query, indexA);
      const resultsB = search(query, indexB);

      const targetFile = 'tech-0.md';
      const resA = resultsA.find((r) => r.entry.filename === targetFile);
      const resB = resultsB.find((r) => r.entry.filename === targetFile);

      // Both indexes contain the same technical corpus, so its score is unchanged.
      expect(resB!.score).toBeCloseTo(resA!.score, 5);
    },
  );

  // -------------------------------------------------------------------------
  // Within-domain ordering must also stay stable as another domain grows.
  // Ranking is controlled by token placement:
  //   tech-rank-0.md — "timeout" appears in TITLE  (highest raw score)
  //   tech-rank-1.md — "timeout" appears in TAG     (medium raw score)
  //   tech-rank-2.md — "timeout" appears only in BODY (lowest raw score,
  //                     but requires title/tag hit from another query token
  //                     so we also put "api" in title)
  //
  // All three entries have the same domain (technical) and type (learnings),
  // so the only differentiator among them is token placement.
  // -------------------------------------------------------------------------
  it(
    'relative ranking among technical entries is preserved when ops entries are added',
    async () => {
      // --- Index A: only the 3 rank-test tech entries ---
      const dirA = path.join(tmpDir, 'learnings-rank-A');
      const idxPathA = path.join(tmpDir, 'index-rank-A.json');

      const rankDocs: Record<string, string> = {
        // Title match: "timeout" in title → score += 3 * idf("title:timeout")
        'tech-rank-0.md': learningDoc(
          'Timeout api guide',
          ['api', 'typescript'],
          'retry config techrank details',
        ),
        // Tag match: "timeout" in tags → score += 2 * idf("tag:timeout")
        'tech-rank-1.md': learningDoc(
          'API retry guide',
          ['api', 'timeout'],
          'retry config techrank details',
        ),
        // Body-only: "timeout" only in body — also has "api" in title for
        // hasTitleOrTagMatch gate to pass.
        'tech-rank-2.md': learningDoc(
          'API config guide',
          ['api', 'typescript'],
          'timeout retry config techrank body only',
        ),
      };

      const indexA = await buildScopedIndex(dirA, idxPathA, rankDocs);

      // --- Index B: same 3 tech entries + N_OPS ops entries ---
      const dirB = path.join(tmpDir, 'learnings-rank-B');
      const idxPathB = path.join(tmpDir, 'index-rank-B.json');

      const rankAndOpsDocs: Record<string, string> = { ...rankDocs };
      for (let i = 0; i < N_OPS; i++) {
        rankAndOpsDocs[`ops-rank-${i}.md`] = learningDoc(
          `Deploy monitor ops ${i}`,
          ['k8s', 'deploy', 'monitor'],
          `timeout retry config opsonly ${i}`,
        );
      }

      const indexB = await buildScopedIndex(dirB, idxPathB, rankAndOpsDocs);

      const query = 'timeout api';

      const resultsA = search(query, indexA);
      const resultsB = search(query, indexB);

      // Extract only the rank-test entries from each result set, in score order
      const rankFiles = ['tech-rank-0.md', 'tech-rank-1.md', 'tech-rank-2.md'];
      const orderA = resultsA
        .filter((r) => rankFiles.includes(r.entry.filename ?? ''))
        .map((r) => r.entry.filename);
      const orderB = resultsB
        .filter((r) => rankFiles.includes(r.entry.filename ?? ''))
        .map((r) => r.entry.filename);

      // All three tech entries must appear in both result sets
      expect(orderA).toHaveLength(3);
      expect(orderB).toHaveLength(3);

      expect(orderB).toEqual(orderA);
    },
  );

  // -------------------------------------------------------------------------
  // Keep the cross-domain document frequencies separate in the persisted index.
  // -------------------------------------------------------------------------
  it('stores document frequencies independently for technical and ops entries', async () => {
    const dirA = path.join(tmpDir, 'learnings-drift-A');
    const idxPathA = path.join(tmpDir, 'index-drift-A.json');

    const techDocs: Record<string, string> = {
      // Only tech-drift-0.md has "timeout" in its body (coverage = 1/N_TECH)
      'tech-drift-0.md': learningDoc(
        'API retry guide',
        ['api', 'typescript', 'debug'],
        'timeout techonly details here',
      ),
      'tech-drift-1.md': learningDoc(
        'API config guide',
        ['api', 'typescript', 'debug'],
        'retry config techonly details here',
      ),
      'tech-drift-2.md': learningDoc(
        'API debug guide',
        ['api', 'debug'],
        'retry config techonly fix here',
      ),
    };

    const indexA = await buildScopedIndex(dirA, idxPathA, techDocs);

    const dirB = path.join(tmpDir, 'learnings-drift-B');
    const idxPathB = path.join(tmpDir, 'index-drift-B.json');

    // All ops docs contain "timeout", but none should enter the technical map.
    const techAndOpsDocs: Record<string, string> = { ...techDocs };
    for (let i = 0; i < N_OPS; i++) {
      techAndOpsDocs[`ops-drift-${i}.md`] = learningDoc(
        `Deploy monitor ops ${i}`,
        ['k8s', 'deploy', 'monitor'],
        `timeout opsonly infrastructure ${i}`,
      );
    }

    const indexB = await buildScopedIndex(dirB, idxPathB, techAndOpsDocs);

    expect(indexA.dfByDomain?.technical?.timeout).toBe(1);
    expect(indexB.dfByDomain?.technical?.timeout).toBe(1);
    expect(indexA.dfByDomain?.technical?.techonly).toBe(N_TECH);
    expect(indexB.dfByDomain?.technical?.techonly).toBe(N_TECH);
    expect(indexB.dfByDomain?.ops?.timeout).toBe(N_OPS);
  });

  // -------------------------------------------------------------------------
  // Test 5 [PASS-NOW — verifies 0b CJK query domain fix]
  //
  // Previously (before the 0b fix), a pure CJK query produced no ASCII tokens,
  // so inferQueryDomain() always returned 'neutral'. After adding CJK word
  // entries to TECHNICAL_TAGS / OPS_TAGS / SUPPORT_TAGS, the tokenizer's
  // 2-char bigram output (e.g. "超时", "重试", "集群", "节点") now matches the
  // tag vocabularies, and Chinese queries resolve to a real domain.
  //
  // This test was previously "CJK query falls back to neutral domain [PASS-NOW]"
  // which characterised the bug. It is now rewritten to verify the fix:
  //
  // Part A — technical CJK query:
  //   query "接口超时重试" → tokens include "超时", "重试", "接口" (all in TECHNICAL_TAGS)
  //   → inferQueryDomain = 'technical'
  //   → DOMAIN_WEIGHT.technical: technical=1.0, ops=0.5
  //   → technical entry score / ops entry score ≈ 1.0/0.5 = 2.0
  //
  // Part B — ops CJK query:
  //   query "集群节点重启" → tokens include "集群", "节点", "重启" (all in OPS_TAGS)
  //   → inferQueryDomain = 'ops'
  //   → DOMAIN_WEIGHT.ops: ops=1.0, technical=0.7
  //   → ops entry should outrank technical entry
  // -------------------------------------------------------------------------
  it('CJK query resolves to a real domain (0b)', async () => {
    const learningsDir = path.join(tmpDir, 'learnings-cjk');

    // Both entries share identical CJK title tokens so their raw IDF scores are
    // equal. The only multiplier difference is the domain weight column.
    // Part A uses technical-leaning Chinese (接口超时重试).
    // Part B uses ops-leaning Chinese (集群节点重启).
    const docs: Record<string, string> = {
      'tech-cjk.md': learningDoc(
        '接口超时重试配置 API technical',
        ['api', 'typescript'],
        '接口超时重试配置说明 timeout retry config',
      ),
      'ops-cjk.md': learningDoc(
        '接口超时重试配置 k8s ops',
        ['k8s', 'deploy'],
        '接口超时重试配置说明 timeout retry config',
      ),
    };

    const index = await buildScopedIndex(learningsDir, indexPath, docs);

    // --- Part A: technical CJK query ---
    // "接口超时重试" → bigrams include 接口/超时/重试, all in TECHNICAL_TAGS
    // → inferQueryDomain = 'technical'
    // → DOMAIN_WEIGHT.technical: technical=1.0, ops=0.5
    const queryTech = '接口超时重试';
    const resultsTech = search(queryTech, index);

    const techResultA = resultsTech.find((r) => r.entry.filename === 'tech-cjk.md');
    const opsResultA = resultsTech.find((r) => r.entry.filename === 'ops-cjk.md');

    expect(techResultA).toBeDefined();
    expect(opsResultA).toBeDefined();

    const ratioA = techResultA!.score / opsResultA!.score;
    console.log(
      `[cjk-domain-0b] Part A (technical query): tech/ops ratio=${ratioA.toFixed(4)}`,
      `expected ≈ ${(1.0 / 0.5).toFixed(4)}`,
      `tech=${techResultA!.score.toFixed(4)}, ops=${opsResultA!.score.toFixed(4)}`,
    );

    // Technical entry must outrank ops entry under a technical query
    expect(techResultA!.score).toBeGreaterThan(opsResultA!.score);
    // Ratio should be close to 1.0/0.5 = 2.0 (technical:ops column weights)
    expect(ratioA).toBeCloseTo(1.0 / 0.5, 1);

    // --- Part B: ops CJK query ---
    // Rebuild index with ops-leaning docs so that ops titles get matching tokens
    const learningsDirB = path.join(tmpDir, 'learnings-cjk-ops');
    const indexPathB = path.join(tmpDir, 'search-index-cjk-ops.json');

    const docsB: Record<string, string> = {
      'tech-cjk-ops.md': learningDoc(
        '集群节点重启排查 API technical',
        ['api', 'typescript'],
        '集群节点重启排查说明 cluster node restart',
      ),
      'ops-cjk-ops.md': learningDoc(
        '集群节点重启排查 k8s ops',
        ['k8s', 'deploy'],
        '集群节点重启排查说明 cluster node restart',
      ),
    };

    const indexB = await buildScopedIndex(learningsDirB, indexPathB, docsB);

    // "集群节点重启" → bigrams include 集群/节点/重启, all in OPS_TAGS
    // → inferQueryDomain = 'ops'
    // → DOMAIN_WEIGHT.ops: ops=1.0, technical=0.7
    const queryOps = '集群节点重启';
    const resultsOps = search(queryOps, indexB);

    const techResultB = resultsOps.find((r) => r.entry.filename === 'tech-cjk-ops.md');
    const opsResultB = resultsOps.find((r) => r.entry.filename === 'ops-cjk-ops.md');

    expect(techResultB).toBeDefined();
    expect(opsResultB).toBeDefined();

    const ratioB = opsResultB!.score / techResultB!.score;
    console.log(
      `[cjk-domain-0b] Part B (ops query): ops/tech ratio=${ratioB.toFixed(4)}`,
      `expected ≈ ${(1.0 / 0.7).toFixed(4)}`,
      `ops=${opsResultB!.score.toFixed(4)}, tech=${techResultB!.score.toFixed(4)}`,
    );

    // Ops entry must outrank technical entry under an ops query
    expect(opsResultB!.score).toBeGreaterThan(techResultB!.score);
    // Ratio should be close to 1.0/0.7 ≈ 1.4286
    expect(ratioB).toBeCloseTo(1.0 / 0.7, 1);
  });
});
