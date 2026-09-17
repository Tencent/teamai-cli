import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { mirrorLearnings } from '../utils/learnings-mirror.js';
import { buildIndex, loadIndex } from '../utils/search-index.js';

describe('mirrorLearnings', () => {
  let tmpDir: string;
  let sourceDir: string;
  let destinationDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-learnings-mirror-'));
    sourceDir = path.join(tmpDir, 'repo-learnings');
    destinationDir = path.join(tmpDir, 'local-learnings');

    await fse.outputFile(path.join(sourceDir, 'shared-a.md'), '# shared a');
    await fse.outputFile(path.join(sourceDir, 'shared-b.md'), '# shared b');
    await fse.outputFile(path.join(sourceDir, 'alpha', 'keep.md'), '# alpha');
    await fse.outputFile(path.join(sourceDir, 'beta', 'private.md'), '# beta');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('keeps what another source root provides instead of deleting it', async () => {
    // The mirror deletes anything its source does not have. With learnings split
    // across roots (#485) a single-source mirror would wipe the other root's
    // learnings out of the machine-local cache on the next pull.
    const otherRoot = path.join(tmpDir, 'learnings-wt-learnings');
    await fse.outputFile(path.join(otherRoot, 'from-the-branch.md'), '# on the branch');
    await fse.outputFile(path.join(otherRoot, 'alpha', 'branch-note.md'), '# alpha on the branch');

    await mirrorLearnings([otherRoot, sourceDir], destinationDir, ['alpha']);

    expect(await fse.pathExists(path.join(destinationDir, 'from-the-branch.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'shared-a.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'alpha', 'branch-note.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'alpha', 'keep.md'))).toBe(true);
  });

  it('gives the first root precedence when a relative path is in two of them', async () => {
    const otherRoot = path.join(tmpDir, 'learnings-wt-learnings');
    await fse.outputFile(path.join(otherRoot, 'shared-a.md'), '# current');

    await mirrorLearnings([otherRoot, sourceDir], destinationDir, []);

    expect(await fse.readFile(path.join(destinationDir, 'shared-a.md'), 'utf8')).toBe('# current');
  });

  it('still removes a learning no root provides any more', async () => {
    const otherRoot = path.join(tmpDir, 'learnings-wt-learnings');
    await fse.outputFile(path.join(otherRoot, 'from-the-branch.md'), '# on the branch');
    await mirrorLearnings([otherRoot, sourceDir], destinationDir, []);

    await fse.remove(path.join(sourceDir, 'shared-b.md'));
    await mirrorLearnings([otherRoot, sourceDir], destinationDir, []);

    expect(await fse.pathExists(path.join(destinationDir, 'shared-b.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destinationDir, 'from-the-branch.md'))).toBe(true);
  });

  it('copies shared learnings and active namespaces only', async () => {
    await mirrorLearnings(sourceDir, destinationDir, ['alpha']);

    expect(await fse.pathExists(path.join(destinationDir, 'shared-a.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'shared-b.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'alpha', 'keep.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destinationDir, 'beta'))).toBe(false);
  });

  it('removes deleted shared and active-namespace learnings before reindexing', async () => {
    await mirrorLearnings(sourceDir, destinationDir, ['alpha']);
    await fse.remove(path.join(sourceDir, 'shared-b.md'));
    await fse.remove(path.join(sourceDir, 'alpha', 'keep.md'));

    await mirrorLearnings(sourceDir, destinationDir, ['alpha']);

    expect(await fse.pathExists(path.join(destinationDir, 'shared-b.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destinationDir, 'alpha', 'keep.md'))).toBe(false);

    const indexPath = path.join(tmpDir, 'search-index.json');
    await buildIndex({
      learningsDir: destinationDir,
      learningsNamespaces: ['alpha'],
      indexPath,
    });
    const index = await loadIndex(indexPath);
    expect(index?.entries.map((entry) => entry.filename)).toEqual(['shared-a.md']);
  });

  it('removes stale namespace directories while preserving unrelated root files', async () => {
    await fse.outputFile(path.join(destinationDir, 'stale.md'), '# stale');
    await fse.outputFile(path.join(destinationDir, 'old-project', 'note.md'), '# old');
    await fse.outputFile(path.join(destinationDir, 'README.txt'), 'local metadata');

    await mirrorLearnings(sourceDir, destinationDir, ['alpha']);

    expect(await fse.pathExists(path.join(destinationDir, 'stale.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destinationDir, 'old-project'))).toBe(false);
    expect(await fse.readFile(path.join(destinationDir, 'README.txt'), 'utf-8')).toBe('local metadata');
  });
});
