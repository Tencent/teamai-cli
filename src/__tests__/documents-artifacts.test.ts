import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTaskDocuments, documentPath, taskDirectory } from '../documents/artifacts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-artifacts-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  const dir = path.join(root, taskDirectory('workspace', 'task'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'intent.md'), '---\ntype: Intent\n---\n# A real intent\n');
  git('add', '.'); git('commit', '-m', 'intent');
  return { root, dir, git };
}

describe('task document versions', () => {
  it('binds committed documents, allows unrelated code changes and rejects changed intent', async () => {
    const { root, dir, git } = await fixture();
    const approved = await checkTaskDocuments(root, 'workspace', 'task', 'intent');
    await fs.writeFile(path.join(root, 'code.txt'), 'new code');
    git('add', '.'); git('commit', '-m', 'code');
    await expect(checkTaskDocuments(root, 'workspace', 'task', 'intent', approved)).resolves.toHaveLength(1);
    await fs.appendFile(path.join(dir, 'intent.md'), 'Different intent');
    await expect(checkTaskDocuments(root, 'workspace', 'task', 'intent', approved)).rejects.toThrow('review it again');
    git('add', '.'); git('commit', '-m', 'changed intent');
    await expect(checkTaskDocuments(root, 'workspace', 'task', 'intent', approved)).rejects.toThrow('review it again');
  });

  it('requires stage files, rejects other task receipts, traversal, symlinks and wrong types', async () => {
    const { root, dir, git } = await fixture();
    const approved = await checkTaskDocuments(root, 'workspace', 'task', 'intent');
    await expect(checkTaskDocuments(root, 'workspace', 'other', 'intent', approved)).rejects.toThrow('another task');
    await expect(checkTaskDocuments(root, 'workspace', 'task', 'spec')).rejects.toThrow();
    expect(() => taskDirectory('../workspace', 'task')).toThrow();
    await expect(documentPath(root, '../outside.md')).rejects.toThrow();
    await fs.symlink(path.join(dir, 'intent.md'), path.join(dir, 'spec.md'));
    await expect(documentPath(root, 'intent/workspace/task/spec.md')).rejects.toThrow('symbolic link');
    await fs.unlink(path.join(dir, 'spec.md'));
    await fs.writeFile(path.join(dir, 'spec.md'), '---\ntype: Intent\n---\nSpec');
    git('add', '.'); git('commit', '-m', 'bad spec');
    await expect(checkTaskDocuments(root, 'workspace', 'task', 'spec')).rejects.toThrow('Specification');
  });
});

it('keeps the task set in the business worktree when the team repository is separate', async () => {
  const { root, git } = await fixture();
  const worktree = `${root}-worktree`;
  roots.push(worktree);
  git('worktree', 'add', '-b', 'task-work', worktree);
  const references = await checkTaskDocuments(worktree, 'workspace', 'task', 'intent');
  expect(references[0]?.path).toBe('intent/workspace/task/intent.md');
  const other = await fixture();
  await fs.writeFile(path.join(other.dir, 'intent.md'), '---\ntype: Intent\n---\nOther repository');
  other.git('add', '.'); other.git('commit', '-m', 'other');
  await expect(checkTaskDocuments(other.root, 'workspace', 'task', 'intent', references)).rejects.toThrow();
});
