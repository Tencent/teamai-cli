import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { mirrorLearnings } from '../learnings-mirror.js';

describe('mirrorLearnings', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fse.remove(root)));
  });

  async function fixture(): Promise<{ source: string; destination: string }> {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-learnings-mirror-'));
    roots.push(root);
    return {
      source: path.join(root, 'source'),
      destination: path.join(root, 'destination'),
    };
  }

  it('propagates shared and active-namespace deletions while preserving unrelated local files', async () => {
    const { source, destination } = await fixture();
    await fse.outputFile(path.join(source, 'shared-current.md'), 'current');
    await fse.outputFile(path.join(source, 'project-a', 'current.md'), 'current');
    await fse.outputFile(path.join(source, 'project-b', 'private.md'), 'private');

    await fse.outputFile(path.join(destination, 'shared-current.md'), 'old');
    await fse.outputFile(path.join(destination, 'shared-deleted.md'), 'stale');
    await fse.outputFile(path.join(destination, 'project-a', 'deleted.md'), 'stale');
    await fse.outputFile(path.join(destination, 'project-b', 'private.md'), 'stale');
    await fse.outputFile(path.join(destination, 'local-note.txt'), 'keep');

    await mirrorLearnings(source, destination, ['project-a']);

    await expect(fse.readFile(path.join(destination, 'shared-current.md'), 'utf8')).resolves.toBe('current');
    await expect(fse.readFile(path.join(destination, 'project-a', 'current.md'), 'utf8')).resolves.toBe('current');
    expect(await fse.pathExists(path.join(destination, 'shared-deleted.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destination, 'project-a', 'deleted.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destination, 'project-b'))).toBe(false);
    await expect(fse.readFile(path.join(destination, 'local-note.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('clears mirrored markdown when the upstream learnings directory is removed', async () => {
    const { source, destination } = await fixture();
    await fse.outputFile(path.join(destination, 'shared-deleted.md'), 'stale');
    await fse.outputFile(path.join(destination, 'project-a', 'deleted.md'), 'stale');

    await mirrorLearnings(source, destination, ['project-a']);

    expect(await fse.pathExists(path.join(destination, 'shared-deleted.md'))).toBe(false);
    expect(await fse.pathExists(path.join(destination, 'project-a'))).toBe(false);
  });
});
