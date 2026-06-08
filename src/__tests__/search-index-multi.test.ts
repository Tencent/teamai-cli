import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { buildIndex, loadIndex, isLegacyIndex, search } from '../utils/search-index.js';
import { SEARCH_INDEX_VERSION } from '../types.js';

describe('buildIndex — Phase 1 multi-category', () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-multi-'));
    indexPath = path.join(tmpDir, 'search-index.json');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('indexes learnings + docs + rules + skills together with correct types', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    const docsDir = path.join(tmpDir, 'docs');
    const rulesDir = path.join(tmpDir, 'rules');
    const skillsDir = path.join(tmpDir, 'skills');

    await fse.ensureDir(learningsDir);
    await fse.ensureDir(docsDir);
    await fse.ensureDir(path.join(rulesDir, 'common'));
    await fse.ensureDir(path.join(skillsDir, 'sample-skill'));

    await fse.writeFile(
      path.join(learningsDir, 'l1.md'),
      '---\ntitle: learning entry\ntags: [api, retry]\n---\nbody about api',
    );
    await fse.writeFile(
      path.join(docsDir, 'overview.md'),
      '---\ntitle: docs entry\ntags: [api]\n---\ndocs body',
    );
    await fse.writeFile(
      path.join(rulesDir, 'common', 'coding-style.md'),
      '---\ntitle: rules entry\ntags: [style]\n---\nrules body',
    );
    await fse.writeFile(
      path.join(skillsDir, 'sample-skill', 'SKILL.md'),
      '---\nname: sample-skill\ndescription: skills entry test\ntags: [skills]\n---\nskill body',
    );

    await buildIndex({ learningsDir, docsDir, rulesDir, skillsDir, indexPath });
    const index = await loadIndex(indexPath);
    expect(index).not.toBeNull();
    expect(index!.version).toBe(SEARCH_INDEX_VERSION);

    const types = index!.entries.map((e) => e.type).sort();
    expect(types).toEqual(['docs', 'learnings', 'rules', 'skills']);

    // Each entry carries an absolute file path
    for (const e of index!.entries) {
      expect(e.path).toBeTruthy();
      expect(path.isAbsolute(e.path!)).toBe(true);
    }

    // Recursive subdirectory paths preserved as filename id (rules/common/...)
    const rulesEntry = index!.entries.find((e) => e.type === 'rules');
    expect(rulesEntry?.filename).toBe(path.join('common', 'coding-style.md'));

    // Skill entry uses skill name as id
    const skillEntry = index!.entries.find((e) => e.type === 'skills');
    expect(skillEntry?.filename).toBe('sample-skill.md');
  });

  it('truncates oversized files (>50KB) instead of dropping them', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    await fse.ensureDir(docsDir);
    const huge = '---\ntitle: huge\n---\n' + 'a'.repeat(60 * 1024);
    await fse.writeFile(path.join(docsDir, 'huge.md'), huge);

    await buildIndex({ docsDir, indexPath });
    const index = await loadIndex(indexPath);
    expect(index!.entries.length).toBe(1);
    expect(index!.entries[0].type).toBe('docs');
  });

  it('skips categories whose source dir does not exist', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);
    await fse.writeFile(
      path.join(learningsDir, 'only.md'),
      '---\ntitle: only\n---\nonly body',
    );

    // Pass paths that don't exist for docs/rules/skills
    await buildIndex({
      learningsDir,
      docsDir: path.join(tmpDir, 'no-docs'),
      rulesDir: path.join(tmpDir, 'no-rules'),
      skillsDir: path.join(tmpDir, 'no-skills'),
      indexPath,
    });

    const index = await loadIndex(indexPath);
    expect(index!.entries.length).toBe(1);
    expect(index!.entries[0].type).toBe('learnings');
  });

  it('produces tokens that include a type:<category> marker', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    await fse.ensureDir(docsDir);
    await fse.writeFile(
      path.join(docsDir, 'a.md'),
      '---\ntitle: alpha\n---\nbody',
    );

    await buildIndex({ docsDir, indexPath });
    const index = await loadIndex(indexPath);
    expect(index!.entries[0].tokens).toContain('type:docs');
  });
});

describe('isLegacyIndex', () => {
  it('returns false for null / missing index (caller should not rebuild)', () => {
    expect(isLegacyIndex(null)).toBe(false);
  });

  it('detects pre-Phase-1 indexes (no version field)', () => {
    const legacy = {
      builtAt: '2026-01-01T00:00:00Z',
      elapsedMs: 10,
      entries: [
        {
          filename: 'old.md',
          title: 'old',
          author: '',
          date: '',
          tags: [],
          tokens: ['old'],
          votes: 0,
        } as unknown as import('../types.js').SearchIndexEntry,
      ],
    };
    expect(isLegacyIndex(legacy)).toBe(true);
  });

  it('detects v2 indexes whose entries are missing type field', () => {
    // A v3-version index (SEARCH_INDEX_VERSION) that still lacks 'type' — treated as legacy
    const partial = {
      version: SEARCH_INDEX_VERSION,
      builtAt: '2026-01-01T00:00:00Z',
      elapsedMs: 10,
      entries: [
        {
          filename: 'no-type.md',
          title: 'no type',
          author: '',
          date: '',
          tags: [],
          tokens: [],
          votes: 0,
          // type missing
        } as unknown as import('../types.js').SearchIndexEntry,
      ],
    };
    expect(isLegacyIndex(partial)).toBe(true);
  });

  it('detects old v2 (Phase 1.3) indexes missing domain field as legacy', () => {
    // Simulates an index built before P1.4 (version=2, has type but no domain).
    // isLegacyIndex() must return true so teamai pull rebuilds the index.
    const v2Index = {
      version: 2, // old pre-P1.4 version
      builtAt: '2026-01-01T00:00:00Z',
      elapsedMs: 10,
      entries: [
        {
          filename: 'has-type-no-domain.md',
          title: 'some learning',
          author: '',
          date: '',
          tags: [],
          tokens: ['type:learnings'],
          votes: 0,
          type: 'learnings' as const,
          // domain: undefined ← missing, as in pre-P1.4 indexes
        } as unknown as import('../types.js').SearchIndexEntry,
      ],
    };
    expect(isLegacyIndex(v2Index)).toBe(true);
  });

  it('returns false for fully populated v3 index (type + domain present)', () => {
    const current = {
      version: SEARCH_INDEX_VERSION,
      builtAt: '2026-01-01T00:00:00Z',
      elapsedMs: 10,
      entries: [
        {
          filename: 'fresh.md',
          title: 'fresh',
          author: '',
          date: '',
          tags: [],
          tokens: ['type:learnings'],
          votes: 0,
          type: 'learnings' as const,
          domain: 'technical' as const, // P1.4 domain field present
        },
      ],
    };
    expect(isLegacyIndex(current)).toBe(false);
  });
});

describe('search — type field surfaces on results', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-search-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('returns the category type on each search result entry', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(docsDir);
    await fse.ensureDir(learningsDir);
    await fse.writeFile(
      path.join(docsDir, 'api.md'),
      '---\ntitle: api timeout\ntags: [api]\n---\ndocs body',
    );
    await fse.writeFile(
      path.join(learningsDir, 'api-fix.md'),
      '---\ntitle: api timeout fix\ntags: [api]\n---\nlearning body',
    );

    const indexPath = path.join(tmpDir, 'idx.json');
    await buildIndex({ docsDir, learningsDir, indexPath });
    const index = await loadIndex(indexPath);
    const results = search('api', index!);
    expect(results.length).toBeGreaterThan(0);
    const types = results.map((r) => r.entry.type).sort();
    expect(types).toContain('docs');
    expect(types).toContain('learnings');
  });
});
