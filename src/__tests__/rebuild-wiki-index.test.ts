import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildWikiIndex } from '../rebuild-wiki-index.js';

/**
 * Regression test for the batch/local-import navigation bug: importing repos
 * populated evidence/code/<slug>/ but the top-level router.md / index.md were
 * never rebuilt, so they stayed frozen at the first single-repo import.
 * rebuildWikiIndex must aggregate ALL repos under evidence/code/ and overwrite
 * any stale top-level navigation.
 */
describe('rebuildWikiIndex', () => {
  let wiki: string;

  beforeEach(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'teamai-wiki-'));
    wiki = path.join(tmp, 'teamwiki');
    const codeDir = path.join(wiki, 'evidence', 'code');
    await mkdir(codeDir, { recursive: true });

    // Three imported repos, each with its own index.md carrying a Facts count.
    for (const [slug, facts] of [['repo-alpha', 10], ['repo-beta', 20], ['repo-gamma', 30]] as const) {
      const dir = path.join(codeDir, slug);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.md'), `# ${slug}\n\nFacts: ${facts}\n`);
    }

    // Stale top-level nav: only one repo listed, wrong repo count.
    await writeFile(path.join(wiki, 'index.md'), '# Team Wiki Index\n\n## Stats\n\n- 仓库: 1\n\nOnly repo-alpha (stale).\n');
    await writeFile(path.join(wiki, 'router.md'), '# Router\n\nOnly repo-alpha (stale).\n');
  });

  afterEach(async () => {
    await rm(path.dirname(wiki), { recursive: true, force: true });
  });

  it('aggregates every repo under evidence/code and overwrites stale navigation', async () => {
    await rebuildWikiIndex(wiki);

    const index = await readFile(path.join(wiki, 'index.md'), 'utf-8');
    const router = await readFile(path.join(wiki, 'router.md'), 'utf-8');

    // All three repos appear in the rebuilt index.
    expect(index).toContain('evidence/code/repo-alpha/index.md');
    expect(index).toContain('evidence/code/repo-beta/index.md');
    expect(index).toContain('evidence/code/repo-gamma/index.md');

    // Repo count reflects the full set, and aggregated Facts total is 60.
    expect(index).toContain('- 仓库: 3');
    expect(index).toContain('- Facts: 60');

    // Stale content is gone from both files.
    expect(index).not.toContain('stale');
    expect(router).not.toContain('stale');
  });

  it('is a no-op when evidence/code does not exist', async () => {
    const empty = path.join(path.dirname(wiki), 'empty-wiki');
    await mkdir(empty, { recursive: true });
    await expect(rebuildWikiIndex(empty)).resolves.toBeUndefined();
  });
});
