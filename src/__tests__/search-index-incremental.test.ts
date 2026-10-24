import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { readFile } from 'node:fs/promises';
import { buildIndex, indexInMemory, loadIndex } from '../utils/search-index.js';

describe('incremental search index (#1239)', () => {
  let dir: string;
  let learningsDir: string;
  let indexPath: string;
  const sourceReads = () => vi.mocked(readFile).mock.calls
    .map(([file]) => String(file)).filter((file) => file.endsWith('.md'));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-index-incremental-'));
    learningsDir = path.join(dir, 'learnings');
    indexPath = path.join(dir, 'index.json');
    await fs.mkdir(learningsDir);
    await fs.writeFile(path.join(learningsDir, 'a.md'), '---\ntitle: Alpha\n---\nOriginal token.');
    await fs.writeFile(path.join(learningsDir, 'b.md'), '---\ntitle: Beta\n---\nOther token.');
    vi.mocked(readFile).mockClear();
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reads no unchanged source, and rebuilds just an edited file', async () => {
    await buildIndex({ learningsDir, indexPath });
    vi.mocked(readFile).mockClear();
    await buildIndex({ learningsDir, indexPath });
    expect(sourceReads()).toEqual([]);

    await fs.writeFile(path.join(learningsDir, 'a.md'), '---\ntitle: Alpha\n---\nChanged token.');
    vi.mocked(readFile).mockClear();
    await buildIndex({ learningsDir, indexPath });
    expect(sourceReads()).toEqual([path.join(learningsDir, 'a.md')]);
    expect((await loadIndex(indexPath))?.entries[0].tokens).toContain('changed');
  });

  it('detects same-size edits with restored mtime and removes deleted entries', async () => {
    await buildIndex({ learningsDir, indexPath });
    const file = path.join(learningsDir, 'a.md');
    const before = await fs.stat(file);
    await fs.writeFile(file, '---\ntitle: Alpha\n---\nModified token.');
    await fs.utimes(file, before.atime, before.mtime);
    await fs.unlink(path.join(learningsDir, 'b.md'));
    await buildIndex({ learningsDir, indexPath });
    const index = (await loadIndex(indexPath))!;
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].tokens).toContain('modified');
    expect(index.entries[0].tokens).not.toContain('original');
  });

  it('reapplies votes and produces the same entries and frequencies as a full build', async () => {
    const votesDir = path.join(dir, 'votes');
    await fs.mkdir(votesDir);
    await fs.writeFile(path.join(votesDir, 'alice.yaml'), 'votes:\n  a:\n    at: 2026-10-23\n');
    await buildIndex({ learningsDir, votesDir, indexPath });
    await fs.unlink(path.join(votesDir, 'alice.yaml'));
    const reused = await indexInMemory({ learningsDir, votesDir, indexPath });
    const full = await indexInMemory({ learningsDir, votesDir, indexPath: path.join(dir, 'absent.json') });
    expect(reused.entries).toEqual(full.entries);
    expect(reused.df).toEqual(full.df);
    expect(reused.dfByDomain).toEqual(full.dfByDomain);
    expect(reused.entries[0].votes).toBe(0);
  });

  it('does not reuse a different source or leak an inactive namespace', async () => {
    const privateDir = path.join(learningsDir, 'private');
    await fs.mkdir(privateDir);
    await fs.writeFile(path.join(privateDir, 'secret.md'), 'Private data.');
    await buildIndex({ learningsDir, learningsNamespaces: ['private'], indexPath });
    const other = path.join(dir, 'queue');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'a.md'), 'Queued edit.');
    await buildIndex({ learningsDirs: [other, learningsDir], indexPath });
    const index = (await loadIndex(indexPath))!;
    expect(index.entries.map((entry) => entry.filename)).toEqual(['a.md', 'b.md']);
    expect(index.entries[0].tokens).toContain('queued');
    expect(JSON.stringify(index)).not.toContain('Private data');
    expect(JSON.stringify(index)).not.toContain('secret.md');
  });

  it('reuses copied bytes without tokenizing again and discards incompatible caches', async () => {
    await buildIndex({ learningsDir, indexPath });
    const before = (await loadIndex(indexPath))!;
    const file = path.join(learningsDir, 'a.md');
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes);
    await buildIndex({ learningsDir, indexPath });
    expect((await loadIndex(indexPath))?.entries).toEqual(before.entries);

    const invalid = (await loadIndex(indexPath))!;
    invalid.fileCache!.derivation = 'obsolete';
    await fs.writeFile(indexPath, JSON.stringify(invalid));
    vi.mocked(readFile).mockClear();
    await buildIndex({ learningsDir, indexPath });
    expect(sourceReads()).toHaveLength(2);
    expect((await loadIndex(indexPath))?.entries).toEqual(before.entries);
  });

  it('keeps every category and recomputes ids and selection independently of cached tokens', async () => {
    const docsDir = path.join(dir, 'docs');
    const rulesDir = path.join(dir, 'rules');
    const skillsDir = path.join(dir, 'skills');
    await fs.mkdir(docsDir);
    await fs.mkdir(rulesDir);
    await fs.mkdir(path.join(skillsDir, 'demo'), { recursive: true });
    await fs.writeFile(path.join(docsDir, 'guide.md'), 'Guide words.');
    await fs.writeFile(path.join(rulesDir, 'rule.md'), 'Rule words.');
    await fs.writeFile(path.join(skillsDir, 'demo', 'SKILL.md'), 'Skill words.');
    const opts = { learningsDir, docsDir, rulesDir, skillsDir, indexPath };
    await buildIndex(opts);
    vi.mocked(readFile).mockClear();
    const cached = await indexInMemory(opts);
    expect(sourceReads()).toEqual([]);
    const full = await indexInMemory({ ...opts, indexPath: path.join(dir, 'full.json') });
    expect(cached.entries).toEqual(full.entries);
    expect(cached.dfByDomain).toEqual(full.dfByDomain);
    const narrowed = await indexInMemory({ ...opts, docFiles: [], ruleFiles: [], skills: { kind: 'dirs', dirs: [] } });
    expect(narrowed.entries.map((entry) => entry.type)).toEqual(['learnings', 'learnings']);
  });
});
