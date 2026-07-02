import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { buildIndex, loadIndex, search } from '../utils/search-index.js';

// ---------------------------------------------------------------------------
// P1.4: Domain-weighted search ranking integration tests
//
// These tests build a real on-disk search index from fixture files and verify
// that the domain × type multipliers produce the expected ranking order.
// ---------------------------------------------------------------------------

let tmpDir: string;
let indexPath: string;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-domain-test-'));
  indexPath = path.join(tmpDir, 'search-index.json');
});

afterEach(async () => {
  await fse.remove(tmpDir);
});

describe('domain-weighted search scoring', () => {
  it('technical entry outranks ops entry with the same raw title/tag score', async () => {
    // Both entries have the same title keyword ("timeout") and one matching tag.
    // The technical entry should rank higher due to DOMAIN_WEIGHT.technical (1.0)
    // vs DOMAIN_WEIGHT.ops (0.5).
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'api-timeout-technical.md'),
      '---\ntitle: "API timeout fix"\ntags: [api]\n---\nUse retry backoff.\n',
    );
    await fse.writeFile(
      path.join(learningsDir, 'k8s-timeout-ops.md'),
      '---\ntitle: "k8s timeout fix"\ntags: [k8s]\n---\nAdjust probe timeout.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);
    expect(index).not.toBeNull();

    const results = search('timeout', index!);
    expect(results.length).toBe(2);

    const technicalEntry = results.find((r) => r.entry.domain === 'technical');
    const opsEntry = results.find((r) => r.entry.domain === 'ops');

    expect(technicalEntry).toBeDefined();
    expect(opsEntry).toBeDefined();

    // technical score should be higher than ops score
    expect(technicalEntry!.score).toBeGreaterThan(opsEntry!.score);
    // First result should be the technical entry
    expect(results[0].entry.domain).toBe('technical');
  });

  it('ops entry is still returned in results (downweighted, not excluded)', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'k8s-rolling-upgrade.md'),
      '---\ntitle: "k8s rolling upgrade"\ntags: [k8s, sop]\n---\nRolling upgrade steps.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);
    const results = search('k8s', index!);

    // The ops entry must still be present — just with a lower score
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.domain).toBe('ops');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('skills type gets TYPE_BONUS (×1.1) over a same-domain learnings entry', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const skillsDir = path.join(tmpDir, 'skills');
    const mySkillDir = path.join(skillsDir, 'code-review');
    await fse.ensureDir(learningsDir);
    await fse.ensureDir(mySkillDir);

    // Both have identical title/tag content but one is a skill (type bonus ×1.1)
    await fse.writeFile(
      path.join(learningsDir, 'code-review-tips.md'),
      '---\ntitle: "code review tips"\ntags: [api, refactor]\n---\nReview code carefully.\n',
    );
    await fse.writeFile(
      path.join(mySkillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: code review tips\ntags: [api, refactor]\n---\nReview code carefully.\n',
    );

    await buildIndex({ learningsDir, skillsDir, indexPath });
    const index = await loadIndex(indexPath);
    const results = search('code review', index!);

    expect(results.length).toBe(2);

    const skillResult = results.find((r) => r.entry.type === 'skills');
    const learningResult = results.find((r) => r.entry.type === 'learnings');

    expect(skillResult).toBeDefined();
    expect(learningResult).toBeDefined();

    // skills ×1.1 on technical domain → 1.0 × 1.1 = 1.1 multiplier
    // learnings ×1.0 on technical domain → 1.0 × 1.0 = 1.0 multiplier
    expect(skillResult!.score).toBeGreaterThan(learningResult!.score);
  });

  it('frontmatter domain:technical overrides tag-inferred ops and boosts ranking', async () => {
    // Entry A has ops tags but declares domain:technical in frontmatter
    // Entry B has ops tags with no frontmatter override → inferred ops
    // Query uses a technical keyword ("timeout") so the query domain is
    // inferred as technical → technical entries are ranked above ops entries.
    // Entry A (frontmatter technical) should therefore outrank Entry B (ops).
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'deploy-override.md'),
      '---\ntitle: "deploy timeout"\ndomain: technical\ntags: [deploy, timeout]\n---\nDeploy steps with technical context.\n',
    );
    await fse.writeFile(
      path.join(learningsDir, 'deploy-normal.md'),
      '---\ntitle: "deploy timeout"\ntags: [deploy]\n---\nDeploy steps.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);
    // "timeout" is in TECHNICAL_TAGS → query domain inferred as technical
    const results = search('deploy timeout', index!);

    expect(results.length).toBe(2);

    // Entry with domain:technical should rank higher than ops-inferred entry
    const overrideResult = results.find((r) => r.entry.filename === 'deploy-override.md');
    const normalResult = results.find((r) => r.entry.filename === 'deploy-normal.md');

    expect(overrideResult).toBeDefined();
    expect(normalResult).toBeDefined();

    expect(overrideResult!.entry.domain).toBe('technical');
    expect(normalResult!.entry.domain).toBe('ops');
    expect(overrideResult!.score).toBeGreaterThan(normalResult!.score);
  });

  it('support-domain query boosts support entries above neutral (query domain inferred from support tokens)', async () => {
    // inferQueryDomain must recognise SUPPORT_TAGS (faq/onboarding/guide/…).
    // A query made of support tokens should be classified as a 'support' query,
    // so a support entry (DOMAIN_WEIGHT.support.support = 1.0) outranks a neutral
    // entry (DOMAIN_WEIGHT.support.neutral = 0.85) even with an equal raw score.
    // Both entries below are identical except for their frontmatter domain.
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'onboarding-faq-support.md'),
      '---\ntitle: "onboarding faq"\ndomain: support\n---\nDetails.\n',
    );
    await fse.writeFile(
      path.join(learningsDir, 'onboarding-faq-neutral.md'),
      '---\ntitle: "onboarding faq"\ndomain: neutral\n---\nDetails.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);
    expect(index).not.toBeNull();

    // "onboarding" and "faq" are both SUPPORT_TAGS → query domain = support
    const results = search('onboarding faq', index!);
    expect(results.length).toBe(2);

    const supportEntry = results.find((r) => r.entry.domain === 'support');
    const neutralEntry = results.find((r) => r.entry.domain === 'neutral');
    expect(supportEntry).toBeDefined();
    expect(neutralEntry).toBeDefined();

    expect(supportEntry!.score).toBeGreaterThan(neutralEntry!.score);
    expect(results[0].entry.domain).toBe('support');
  });

  it('built index carries domain field on every entry (version 5)', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'some-learning.md'),
      '---\ntitle: "some learning"\ntags: [api]\n---\nBody.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);

    expect(index).not.toBeNull();
    expect(index!.version).toBe(5);

    for (const entry of index!.entries) {
      expect(entry.domain).toBeDefined();
      expect(['technical', 'ops', 'support', 'neutral']).toContain(entry.domain);
    }
  });
});
