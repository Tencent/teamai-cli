import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import {
  fileContentEqual,
  dirContentEqual,
  getFileMtime,
  getDirLatestMtime,
  hasVcsMetadataRecursive,
  pruneEmptyDirs,
} from '../utils/fs.js';

describe('fileContentEqual', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fs-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return true for files with identical content', async () => {
    const fileA = path.join(tmpDir, 'a.md');
    const fileB = path.join(tmpDir, 'b.md');
    await fse.writeFile(fileA, 'hello world');
    await fse.writeFile(fileB, 'hello world');

    expect(await fileContentEqual(fileA, fileB)).toBe(true);
  });

  it('should return false for files with different content', async () => {
    const fileA = path.join(tmpDir, 'a.md');
    const fileB = path.join(tmpDir, 'b.md');
    await fse.writeFile(fileA, 'hello');
    await fse.writeFile(fileB, 'world');

    expect(await fileContentEqual(fileA, fileB)).toBe(false);
  });

  it('should return false when first file does not exist', async () => {
    const fileB = path.join(tmpDir, 'b.md');
    await fse.writeFile(fileB, 'content');

    expect(await fileContentEqual(path.join(tmpDir, 'missing.md'), fileB)).toBe(false);
  });

  it('should return false when second file does not exist', async () => {
    const fileA = path.join(tmpDir, 'a.md');
    await fse.writeFile(fileA, 'content');

    expect(await fileContentEqual(fileA, path.join(tmpDir, 'missing.md'))).toBe(false);
  });

  it('should return true for two empty files', async () => {
    const fileA = path.join(tmpDir, 'a.md');
    const fileB = path.join(tmpDir, 'b.md');
    await fse.writeFile(fileA, '');
    await fse.writeFile(fileB, '');

    expect(await fileContentEqual(fileA, fileB)).toBe(true);
  });
});

describe('getFileMtime', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fs-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return a positive number for an existing file', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await fse.writeFile(filePath, 'content');

    const mtime = await getFileMtime(filePath);
    expect(mtime).toBeGreaterThan(0);
  });

  it('should return 0 for a non-existent file', async () => {
    const mtime = await getFileMtime(path.join(tmpDir, 'missing.md'));
    expect(mtime).toBe(0);
  });

  it('should return a later mtime for a file written later', async () => {
    const fileA = path.join(tmpDir, 'a.md');
    await fse.writeFile(fileA, 'first');
    const mtimeA = await getFileMtime(fileA);

    await new Promise((r) => setTimeout(r, 50));

    const fileB = path.join(tmpDir, 'b.md');
    await fse.writeFile(fileB, 'second');
    const mtimeB = await getFileMtime(fileB);

    expect(mtimeB).toBeGreaterThan(mtimeA);
  });
});

describe('getDirLatestMtime', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fs-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return 0 for a non-existent directory', async () => {
    const mtime = await getDirLatestMtime(path.join(tmpDir, 'missing'));
    expect(mtime).toBe(0);
  });

  it('should return 0 for an empty directory', async () => {
    const dir = path.join(tmpDir, 'empty');
    await fse.ensureDir(dir);

    const mtime = await getDirLatestMtime(dir);
    expect(mtime).toBe(0);
  });

  it('should return the mtime of the newest file in a flat directory', async () => {
    const dir = path.join(tmpDir, 'flat');
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'old.md'), 'old');

    await new Promise((r) => setTimeout(r, 50));

    await fse.writeFile(path.join(dir, 'new.md'), 'new');
    const expectedMtime = await getFileMtime(path.join(dir, 'new.md'));

    const mtime = await getDirLatestMtime(dir);
    expect(mtime).toBe(expectedMtime);
  });

  it('should find the newest file in a nested directory', async () => {
    const dir = path.join(tmpDir, 'nested');
    await fse.ensureDir(path.join(dir, 'sub'));
    await fse.writeFile(path.join(dir, 'top.md'), 'top');

    await new Promise((r) => setTimeout(r, 50));

    await fse.writeFile(path.join(dir, 'sub', 'deep.md'), 'deep');
    const expectedMtime = await getFileMtime(path.join(dir, 'sub', 'deep.md'));

    const mtime = await getDirLatestMtime(dir);
    expect(mtime).toBe(expectedMtime);
  });
});

describe('dirContentEqual', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fs-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return true for two directories with identical files', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'content');
    await fse.writeFile(path.join(dirB, 'file.md'), 'content');

    expect(await dirContentEqual(dirA, dirB)).toBe(true);
  });

  it('should return false when file content differs', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'v1');
    await fse.writeFile(path.join(dirB, 'file.md'), 'v2');

    expect(await dirContentEqual(dirA, dirB)).toBe(false);
  });

  it('should return false when one dir has an extra file', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'content');
    await fse.writeFile(path.join(dirB, 'file.md'), 'content');
    await fse.writeFile(path.join(dirB, 'extra.md'), 'extra');

    expect(await dirContentEqual(dirA, dirB)).toBe(false);
  });

  it('should return false when first dir does not exist', async () => {
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirB, 'file.md'), 'content');

    expect(await dirContentEqual(path.join(tmpDir, 'missing'), dirB)).toBe(false);
  });

  it('should return false when second dir does not exist', async () => {
    const dirA = path.join(tmpDir, 'a');
    await fse.ensureDir(dirA);
    await fse.writeFile(path.join(dirA, 'file.md'), 'content');

    expect(await dirContentEqual(dirA, path.join(tmpDir, 'missing'))).toBe(false);
  });

  it('should compare nested subdirectories recursively', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(path.join(dirA, 'sub'));
    await fse.ensureDir(path.join(dirB, 'sub'));
    await fse.writeFile(path.join(dirA, 'top.md'), 'top');
    await fse.writeFile(path.join(dirB, 'top.md'), 'top');
    await fse.writeFile(path.join(dirA, 'sub', 'deep.md'), 'deep');
    await fse.writeFile(path.join(dirB, 'sub', 'deep.md'), 'deep');

    expect(await dirContentEqual(dirA, dirB)).toBe(true);
  });

  it('should return false when nested file content differs', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(path.join(dirA, 'sub'));
    await fse.ensureDir(path.join(dirB, 'sub'));
    await fse.writeFile(path.join(dirA, 'top.md'), 'top');
    await fse.writeFile(path.join(dirB, 'top.md'), 'top');
    await fse.writeFile(path.join(dirA, 'sub', 'deep.md'), 'v1');
    await fse.writeFile(path.join(dirB, 'sub', 'deep.md'), 'v2');

    expect(await dirContentEqual(dirA, dirB)).toBe(false);
  });

  it('should return true for two empty directories', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);

    expect(await dirContentEqual(dirA, dirB)).toBe(true);
  });

  it('should return true when only ignored files differ', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'same');
    await fse.writeFile(path.join(dirB, 'file.md'), 'same');
    // dirB has an extra CONTRIBUTORS file
    await fse.writeFile(path.join(dirB, 'CONTRIBUTORS'), 'alice\n');

    expect(await dirContentEqual(dirA, dirB, ['CONTRIBUTORS'])).toBe(true);
  });

  it('should still detect real differences when using ignore', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'v1');
    await fse.writeFile(path.join(dirB, 'file.md'), 'v2');
    await fse.writeFile(path.join(dirB, 'CONTRIBUTORS'), 'alice\n');

    expect(await dirContentEqual(dirA, dirB, ['CONTRIBUTORS'])).toBe(false);
  });

  it('should return true when both dirs have ignored files with different content', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fse.ensureDir(dirA);
    await fse.ensureDir(dirB);
    await fse.writeFile(path.join(dirA, 'file.md'), 'same');
    await fse.writeFile(path.join(dirB, 'file.md'), 'same');
    await fse.writeFile(path.join(dirA, 'CONTRIBUTORS'), 'alice\n');
    await fse.writeFile(path.join(dirB, 'CONTRIBUTORS'), 'bob\n');

    expect(await dirContentEqual(dirA, dirB, ['CONTRIBUTORS'])).toBe(true);
  });
});

describe('hasVcsMetadataRecursive', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-vcs-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('returns false for a plain directory tree with no VCS metadata', async () => {
    await fse.outputFile(path.join(tmpDir, 'SKILL.md'), '# x');
    await fse.outputFile(path.join(tmpDir, 'scripts', 'run.py'), 'x');
    expect(await hasVcsMetadataRecursive(tmpDir)).toBe(false);
  });

  it('detects a .git directory at the root', async () => {
    await fse.outputFile(path.join(tmpDir, 'SKILL.md'), '# x');
    await fse.ensureDir(path.join(tmpDir, '.git'));
    expect(await hasVcsMetadataRecursive(tmpDir)).toBe(true);
  });

  it('detects a NESTED .git directory (scripts/.git)', async () => {
    await fse.outputFile(path.join(tmpDir, 'scripts', 'run.py'), 'x');
    await fse.ensureDir(path.join(tmpDir, 'scripts', '.git'));
    expect(await hasVcsMetadataRecursive(tmpDir)).toBe(true);
  });

  it('detects a .git FILE (submodule/worktree link), not just a directory', async () => {
    await fse.outputFile(path.join(tmpDir, 'sub', '.git'), 'gitdir: /elsewhere/.git/modules/sub\n');
    expect(await hasVcsMetadataRecursive(tmpDir)).toBe(true);
  });

  it('detects .hg and .svn too', async () => {
    const hg = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hg-'));
    const svn = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-svn-'));
    try {
      await fse.ensureDir(path.join(hg, 'a', '.hg'));
      await fse.ensureDir(path.join(svn, '.svn'));
      expect(await hasVcsMetadataRecursive(hg)).toBe(true);
      expect(await hasVcsMetadataRecursive(svn)).toBe(true);
    } finally {
      await fse.remove(hg);
      await fse.remove(svn);
    }
  });

  it('ignores .git inside node_modules (dependency noise, not user work)', async () => {
    await fse.outputFile(path.join(tmpDir, 'SKILL.md'), '# x');
    await fse.ensureDir(path.join(tmpDir, 'node_modules', 'dep', '.git'));
    expect(await hasVcsMetadataRecursive(tmpDir)).toBe(false);
  });

  it('returns false for a missing directory', async () => {
    expect(await hasVcsMetadataRecursive(path.join(tmpDir, 'nope'))).toBe(false);
  });
});

describe('pruneEmptyDirs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-prune-test-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('removes a directory tree that contains no files', async () => {
    const target = path.join(tmpDir, 'skills', 'channel-bill-push-test');
    await fse.ensureDir(path.join(target, 'assets'));
    await fse.ensureDir(path.join(target, 'references'));

    await pruneEmptyDirs(target);

    expect(await fse.pathExists(target)).toBe(false);
    expect(await fse.pathExists(path.join(tmpDir, 'skills'))).toBe(true);
  });

  it('keeps the directory and prunes only its empty subdirectories', async () => {
    const target = path.join(tmpDir, 'skills', 'my-skill');
    await fse.outputFile(path.join(target, 'SKILL.md'), '# x');
    await fse.ensureDir(path.join(target, 'assets'));
    await fse.outputFile(path.join(target, 'scripts', 'run.sh'), 'echo hi');

    await pruneEmptyDirs(target);

    expect(await fse.pathExists(path.join(target, 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(target, 'scripts', 'run.sh'))).toBe(true);
    expect(await fse.pathExists(path.join(target, 'assets'))).toBe(false);
  });

  it('does nothing for a missing path or a file', async () => {
    const file = path.join(tmpDir, 'teamai.yaml');
    await fse.outputFile(file, 'team: x');

    await pruneEmptyDirs(path.join(tmpDir, 'nope'));
    await pruneEmptyDirs(file);

    expect(await fse.pathExists(file)).toBe(true);
  });
});
